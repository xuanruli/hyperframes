import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Image generation via the OpenAI Codex CLI's built-in image tool (gpt-image-2)
// on the user's ChatGPT subscription: the codex CLI owns auth, media-use holds
// no key (CLI-only). The image UPSELL behind local mflux; skipped by --local-only.
//
// Retrieval mirrors illo-skill rather than trusting the model to save a file:
// `--enable imagegenext` makes the built-in tool drop the rendered artifact into
// $CODEX_HOME/generated_images/, and we fetch the freshest file that postdates
// this run. The save-to-path instruction is only a best-effort verify-first.

const TIMEOUT_MS = 600000; // codex exec round-trips the sub; first-run tool spin-up is slow
const MTIME_SKEW_MS = 2000; // tolerate mtime granularity / clock skew (illo uses 2s)

function codexGeneratedDir() {
  // Codex relocates CODEX_HOME on some hosts, so resolve it at run time.
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "generated_images");
}

// Newest artifact that postdates `sinceMs` (minus skew), so a stale prior render
// or a concurrent session's file can't be mistaken for this run's output.
function freshestGeneratedImage(sinceMs) {
  const dir = codexGeneratedDir();
  if (!existsSync(dir)) return null;
  const floor = sinceMs - MTIME_SKEW_MS;
  let best = null;
  for (const name of readdirSync(dir)) {
    let st;
    try {
      st = statSync(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile() || st.mtimeMs < floor) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: join(dir, name), mtimeMs: st.mtimeMs };
  }
  return best?.path ?? null;
}

export async function codexImageGenerate(intent) {
  const outPath = join(tmpdir(), `media-use-codex-${process.pid}-${Date.now()}.png`);
  const prompt =
    `${intent}\n\n` +
    `Use your built-in image generation tool to render this, then save the image ` +
    `to ${outPath} (overwrite if it exists). Do not ask for confirmation. ` +
    `If you have no built-in image tool, do nothing (no PIL/matplotlib/SVG substitute).`;
  try {
    unlinkSync(outPath); // clear any prior file so verify-first can't accept a stale render
  } catch {
    /* no prior file */
  }
  const started = Date.now();
  try {
    execFileSync(
      "codex",
      [
        "exec",
        "--cd",
        tmpdir(),
        "-s",
        "workspace-write",
        "--skip-git-repo-check",
        "--enable",
        "imagegenext",
        "-",
      ],
      { input: prompt, encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch (err) {
    console.error(
      `media-use: \`codex exec\` image generation failed: ${err.stderr?.toString().trim().slice(-200) || err.message}`,
    );
    return null;
  }
  // Verify-first (save-to-path may have worked), else fetch the imagegenext artifact.
  const produced =
    existsSync(outPath) && statSync(outPath).size > 0 ? outPath : freshestGeneratedImage(started);
  if (!produced) return null;
  if (produced !== outPath) {
    try {
      copyFileSync(produced, outPath);
    } catch {
      return null;
    }
  }
  return {
    localPath: outPath,
    ext: ".png",
    source: "generated",
    metadata: { description: intent, provider: "codex.image_gen", provenance: { prompt: intent } },
  };
}
