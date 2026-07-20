import { spawn } from "node:child_process";
import type { RenderSpec } from "./types.js";

/**
 * OUTPUT QC — the missing half of the automation loop.
 *
 * Every quality defect this project has hit was found by a human watching the
 * output: colliding captions, clipped speech, a sped-up hook, interjections that
 * were written but never spoken, a teaser cut mid-word. That works while one
 * person reviews everything; it does not survive 45 clips/day across 3 channels.
 *
 * These checks run AFTER render and BEFORE publish. A "block" issue means the clip
 * is still written to storage (so it can be inspected) but is NOT published.
 * QC itself must never break the pipeline: if a probe fails we record a warning
 * and let the clip through rather than losing the render.
 */

export type QcSeverity = "block" | "warn";

export interface QcIssue {
  code: string;
  severity: QcSeverity;
  detail: string;
}

export interface QcReport {
  blocked: boolean;
  issues: QcIssue[];
  metrics: Record<string, number | string | null>;
}

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const p = spawn(cmd, args);
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout?.on("data", (d) => (stdout += String(d)));
    p.stderr?.on("data", (d) => (stderr += String(d)));
    p.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stderr, stdout });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr, stdout });
    });
  });
}

const wordCount = (s: string): number =>
  String(s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/**
 * Speech-rate sanity. This is the check that would have caught the sped-up
 * ("chipmunk") hook that shipped on roughly one clip in three or four: a 12-word
 * line arriving as 1.2s of audio is ~10 words/sec, which no human speaks at.
 */
const WPS_MIN = 1.2;
const WPS_MAX = 5.5;

/** A VO card must be longer than its audio, or the last word gets cut off. */
const MIN_VO_HEADROOM = 0.05;

export async function qcRenderedClip(
  spec: RenderSpec,
  mp4Path: string,
  expectedSec: number,
): Promise<QcReport> {
  const issues: QcIssue[] = [];
  const metrics: Record<string, number | string | null> = {};

  // ---------------------------------------------------------------------
  // 1) SPEC CHECKS — no ffmpeg needed, uses the durations we already measured.
  // ---------------------------------------------------------------------
  const vos: Array<{ label: string; text: string; dur: number | null | undefined }> = [
    { label: "hook", text: spec.hook_text || "", dur: spec.audio.hook_duration_s },
    { label: "takeaway", text: spec.takeaway_text || "", dur: spec.audio.takeaway_duration_s },
    ...spec.audio.interjections.map((it, i) => ({
      label: `interjection_${i + 1}`,
      text: it.text ?? "",
      dur: it.duration_s,
    })),
  ];

  for (const vo of vos) {
    const words = wordCount(vo.text);
    if (!vo.dur || vo.dur <= 0 || words === 0) continue;
    const wps = words / vo.dur;
    metrics[`wps_${vo.label}`] = Number(wps.toFixed(2));
    if (wps > WPS_MAX) {
      issues.push({
        code: "speech_rate_fast",
        severity: "block",
        detail: `${vo.label}: ${words} words in ${vo.dur.toFixed(2)}s = ${wps.toFixed(1)} words/sec (max ${WPS_MAX}) — audio is sped up or truncated`,
      });
    } else if (wps < WPS_MIN) {
      issues.push({
        code: "speech_rate_slow",
        severity: "warn",
        detail: `${vo.label}: ${wps.toFixed(1)} words/sec (min ${WPS_MIN}) — audio may be stalled or padded`,
      });
    }
  }

  // Teaser must not end mid-word (regression guard on the cold-open snap).
  // NOTE: do NOT also allow a "near a word boundary" tolerance here — spoken words
  // are often only 0.3-0.5s long, so any such tolerance is wider than the word itself
  // and cancels the check on virtually every real cut. The +/-0.06s margins below are
  // the only slack needed: they stop us flagging a cut that lands ON a boundary.
  if (spec.teaser_end_sec != null && spec.captions.length) {
    const absEnd = spec.t_in + spec.teaser_end_sec;
    const insideWord = spec.captions.some((w) => absEnd > w.start + 0.06 && absEnd < w.end - 0.06);
    if (insideWord) {
      issues.push({
        code: "teaser_midword",
        severity: "warn",
        detail: `teaser ends at ${spec.teaser_end_sec.toFixed(2)}s, inside a spoken word — harsh cut`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 2) OUTPUT FILE CHECKS — one ffprobe + one ffmpeg analysis pass.
  // ---------------------------------------------------------------------
  const probe = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-show_entries", "stream=codec_type,width,height",
    "-of", "default=noprint_wrappers=1",
    mp4Path,
  ]);

  if (probe.code !== 0) {
    issues.push({
      code: "probe_failed",
      severity: "warn",
      detail: `ffprobe failed (${probe.code}) — output checks skipped`,
    });
    return { blocked: issues.some((i) => i.severity === "block"), issues, metrics };
  }

  const durMatch = /duration=([0-9.]+)/.exec(probe.stdout);
  const actualSec = durMatch ? Number(durMatch[1]) : null;
  metrics.duration_s = actualSec;
  metrics.expected_s = Number(expectedSec.toFixed(2));

  // Output resolution. Shorts is a 1080x1920-native surface; anything smaller means we
  // handed YouTube an upscaled master and it re-encoded the softness in. This shipped
  // silently for weeks because the render simply used a 2/3 scale factor and nothing
  // ever asserted the result — a human eventually noticed the title looked soft.
  const wMatch = /^width=(\d+)/m.exec(probe.stdout);
  const hMatch = /^height=(\d+)/m.exec(probe.stdout);
  const width = wMatch ? Number(wMatch[1]) : null;
  const height = hMatch ? Number(hMatch[1]) : null;
  metrics.width = width;
  metrics.height = height;
  if (width != null && height != null && width > 0) {
    if (width < 1080 || height < 1920) {
      issues.push({
        code: "low_resolution",
        severity: "warn",
        detail: `output is ${width}x${height}, expected 1080x1920 — check RENDER_SCALE`,
      });
    }
    const aspect = height / width;
    if (Math.abs(aspect - 16 / 9) > 0.02) {
      issues.push({
        code: "wrong_aspect",
        severity: "block",
        detail: `output aspect ${width}x${height} is not 9:16`,
      });
    }
  }

  const hasAudio = /codec_type=audio/.test(probe.stdout);
  const hasVideo = /codec_type=video/.test(probe.stdout);
  if (!hasAudio) {
    issues.push({ code: "no_audio_stream", severity: "block", detail: "rendered file has no audio stream" });
  }
  if (!hasVideo) {
    issues.push({ code: "no_video_stream", severity: "block", detail: "rendered file has no video stream" });
  }

  // Truncated / overlong render — the timeline is the source of truth.
  if (actualSec != null && expectedSec > 0) {
    const drift = Math.abs(actualSec - expectedSec);
    metrics.duration_drift_s = Number(drift.toFixed(2));
    if (drift > 1.0) {
      issues.push({
        code: "duration_mismatch",
        severity: "block",
        detail: `rendered ${actualSec.toFixed(2)}s vs expected ${expectedSec.toFixed(2)}s (drift ${drift.toFixed(2)}s) — likely truncated`,
      });
    }
  }

  // Single analysis pass: loudness + silence + black frames.
  // NOTE: deliberately NOT using freezedetect — this format intentionally freezes
  // on every Matt card, so it would false-positive on correct output.
  const analyse = await run("ffmpeg", [
    "-nostdin",
    "-i", mp4Path,
    "-af", "ebur128=peak=true,silencedetect=noise=-50dB:d=2.0",
    "-vf", "blackdetect=d=0.6:pix_th=0.10",
    "-f", "null",
    "-",
  ]);

  const err = analyse.stderr;

  // Integrated loudness (EBU R128). Shorts should sit roughly -16..-10 LUFS.
  const lufsMatch = /I:\s*(-?[0-9.]+)\s*LUFS/g;
  let lufs: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = lufsMatch.exec(err)) !== null) lufs = Number(m[1]);
  metrics.lufs = lufs;
  if (lufs != null && Number.isFinite(lufs)) {
    if (lufs > -8) {
      issues.push({ code: "too_loud", severity: "warn", detail: `integrated loudness ${lufs} LUFS (target ~-14)` });
    } else if (lufs < -22) {
      issues.push({ code: "too_quiet", severity: "warn", detail: `integrated loudness ${lufs} LUFS (target ~-14)` });
    }
  }

  // Dead air: a silence run of 2s+ inside a 60s clip is a defect worth seeing.
  const silences = [...err.matchAll(/silence_duration:\s*([0-9.]+)/g)].map((x) => Number(x[1]));
  const longestSilence = silences.length ? Math.max(...silences) : 0;
  metrics.longest_silence_s = Number(longestSilence.toFixed(2));
  if (longestSilence >= 2.5) {
    issues.push({
      code: "dead_air",
      severity: "warn",
      detail: `${longestSilence.toFixed(1)}s of continuous silence`,
    });
  }

  // Black frames = broken render (our format is never black for this long).
  const blacks = [...err.matchAll(/black_duration:\s*([0-9.]+)/g)].map((x) => Number(x[1]));
  const longestBlack = blacks.length ? Math.max(...blacks) : 0;
  metrics.longest_black_s = Number(longestBlack.toFixed(2));
  if (longestBlack >= 0.6) {
    issues.push({
      code: "black_frames",
      severity: "block",
      detail: `${longestBlack.toFixed(1)}s of black video — render likely corrupt`,
    });
  }

  return { blocked: issues.some((i) => i.severity === "block"), issues, metrics };
}
