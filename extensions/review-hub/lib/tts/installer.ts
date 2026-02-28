/**
 * TTS Auto-Installer — Manages Python virtual environments and TTS dependencies.
 *
 * Handles pre-flight checks (Python version, platform, disk space),
 * venv creation, package installation, and status caching.
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { TTSProvider } from "./provider.js";

// ── Constants ──────────────────────────────────────────────────────────────

const REVIEW_HUB_DIR = path.join(os.homedir(), ".pi", "review-hub");
const INSTALL_STATUS_FILE = path.join(REVIEW_HUB_DIR, "install-status.json");
const MIN_PYTHON_VERSION = [3, 10] as const;
const MIN_DISK_GB = 5;

// ── Types ──────────────────────────────────────────────────────────────────

interface InstallStatus {
  [providerName: string]: {
    installed: boolean;
    venvPath: string;
    installedAt: string;
    pythonVersion: string;
    platform: string;
  };
}

interface PlatformInfo {
  isAppleSilicon: boolean;
  arch: string;
  platform: string;
  torchIndexUrl?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Ensure a TTS provider is available, installing if needed.
 *
 * @param provider - The TTS provider to check/install
 * @param ui - UI context for confirmation and progress (or simple callbacks)
 * @returns true if provider is ready, false if user declined installation
 */
export async function ensureTTSAvailable(
  provider: TTSProvider,
  ui: {
    confirm: (title: string, message: string) => Promise<boolean>;
    setStatus: (key: string, text: string | undefined) => void;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  },
): Promise<boolean> {
  // Check cached status first
  if (isInstalledCached(provider.name)) {
    // Verify the venv still exists
    const status = loadInstallStatus();
    const providerStatus = status[provider.name];
    if (providerStatus && isVenvValid(providerStatus.venvPath)) {
      return true;
    }
    // Cache is stale — remove it
    clearInstallStatus(provider.name);
  }

  // Check if already available (maybe installed outside our management)
  if (await provider.isAvailable()) {
    return true;
  }

  // Show confirmation dialog
  const confirmed = await ui.confirm(
    "TTS Setup Required",
    `${provider.name} TTS is not installed. This will:\n` +
      `• Create a Python virtual environment (~50MB)\n` +
      `• Install ${provider.name} and dependencies (~2GB download)\n` +
      `• Location: ~/.pi/review-hub/venv-${provider.name}/\n\n` +
      `Continue?`,
  );

  if (!confirmed) {
    return false;
  }

  // Pre-flight checks
  ui.setStatus("review-hub", "Running pre-flight checks...");

  try {
    const pythonVersion = checkPythonVersion();
    ui.setStatus("review-hub", `Python ${pythonVersion} detected ✓`);
  } catch (err) {
    ui.notify(`Python check failed: ${(err as Error).message}`, "error");
    return false;
  }

  const platform = checkPlatformCompatibility();
  ui.setStatus(
    "review-hub",
    `Platform: ${platform.arch} ${platform.isAppleSilicon ? "(Apple Silicon)" : ""} ✓`,
  );

  try {
    checkDiskSpace();
  } catch (err) {
    const proceed = await ui.confirm(
      "Low Disk Space",
      `${(err as Error).message}\n\nContinue anyway?`,
    );
    if (!proceed) return false;
  }

  // Install
  try {
    await provider.install(
      (msg) => ui.setStatus("review-hub", msg),
      (msg) => ui.confirm("Installation", msg),
    );

    // Cache the installation status
    saveInstallStatus(provider.name, {
      installed: true,
      venvPath: getVenvPath(provider.name),
      installedAt: new Date().toISOString(),
      pythonVersion: checkPythonVersion(),
      platform: `${platform.platform}-${platform.arch}`,
    });

    ui.setStatus("review-hub", `${provider.name} TTS installed ✓`);
    ui.notify(`${provider.name} TTS installed successfully!`, "info");
    return true;
  } catch (err) {
    ui.notify(`Installation failed: ${(err as Error).message}`, "error");
    ui.setStatus("review-hub", undefined);
    return false;
  }
}

// ── Pre-flight Checks ──────────────────────────────────────────────────────

/**
 * Check that Python >= 3.10 is available.
 * @returns Version string like "3.11.5"
 * @throws If Python is not found or version is too old
 */
export function checkPythonVersion(): string {
  try {
    const output = execSync("python3 --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const match = output.match(/Python (\d+)\.(\d+)\.?(\d*)/);
    if (!match) {
      throw new Error(`Could not parse Python version from: ${output}`);
    }

    const major = parseInt(match[1]!, 10);
    const minor = parseInt(match[2]!, 10);

    if (major < MIN_PYTHON_VERSION[0] || (major === MIN_PYTHON_VERSION[0] && minor < MIN_PYTHON_VERSION[1])) {
      throw new Error(
        `Python ${major}.${minor} found, but >= ${MIN_PYTHON_VERSION[0]}.${MIN_PYTHON_VERSION[1]} is required`,
      );
    }

    return `${major}.${minor}${match[3] ? "." + match[3] : ""}`;
  } catch (err) {
    if ((err as Error).message.includes("Python")) throw err;
    throw new Error("Python 3 not found. Install Python 3.10+ from https://www.python.org/");
  }
}

/**
 * Detect platform and architecture for appropriate package selection.
 */
export function checkPlatformCompatibility(): PlatformInfo {
  const arch = os.arch();
  const platform = os.platform();
  const isAppleSilicon = platform === "darwin" && arch === "arm64";

  const info: PlatformInfo = {
    isAppleSilicon,
    arch,
    platform,
  };

  // Apple Silicon uses MPS for torch acceleration
  if (isAppleSilicon) {
    info.torchIndexUrl = undefined; // Default pip works for Apple Silicon now
  }

  return info;
}

/**
 * Check that there's enough disk space for TTS installation.
 * @throws If less than MIN_DISK_GB available
 */
export function checkDiskSpace(): void {
  try {
    const output = execSync("df -g ~ | tail -1", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parts = output.trim().split(/\s+/);
    // df -g output: Filesystem Size Used Avail ...
    const availIdx = parts.length >= 4 ? 3 : -1;
    if (availIdx >= 0) {
      const availGB = parseInt(parts[availIdx]!, 10);
      if (!isNaN(availGB) && availGB < MIN_DISK_GB) {
        throw new Error(
          `Only ${availGB}GB free disk space. TTS installation needs ~${MIN_DISK_GB}GB.`,
        );
      }
    }
  } catch (err) {
    if ((err as Error).message.includes("disk space")) throw err;
    // Can't determine disk space — proceed anyway
  }
}

// ── Venv Management ────────────────────────────────────────────────────────

/**
 * Get the venv path for a provider.
 */
export function getVenvPath(providerName: string): string {
  return path.join(REVIEW_HUB_DIR, `venv-${providerName}`);
}

/**
 * Check if a venv exists and has a working Python binary.
 */
export function isVenvValid(venvPath: string): boolean {
  const pythonPath = path.join(venvPath, "bin", "python");
  if (!fs.existsSync(pythonPath)) {
    return false;
  }

  try {
    execSync(`"${pythonPath}" --version`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new Python virtual environment.
 */
export async function createVenv(venvPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(venvPath), { recursive: true });

  return new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", ["-m", "venv", venvPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to create venv (exit ${code}): ${stderr.slice(0, 500)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn python3: ${err.message}`));
    });
  });
}

/**
 * Install packages into a venv using pip.
 */
export async function installPackages(
  venvPath: string,
  requirements: Record<string, string>,
  onProgress: (msg: string) => void,
  indexUrl?: string,
): Promise<void> {
  const pipPath = path.join(venvPath, "bin", "pip");

  // First upgrade pip itself
  onProgress("Upgrading pip...");
  await runCommand(pipPath, ["install", "--upgrade", "pip"]);

  // Build requirements list
  const pkgs = Object.entries(requirements).map(([name, version]) =>
    version ? `${name}==${version}` : name,
  );

  const args = ["install", ...pkgs];
  if (indexUrl) {
    args.push("--index-url", indexUrl);
  }

  onProgress(`Installing ${pkgs.length} packages...`);
  await runCommand(pipPath, args);
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed (exit ${code}): ${command} ${args.join(" ")}\n${stderr.slice(0, 1000)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run ${command}: ${err.message}`));
    });
  });
}

// ── WAV → MP3 Conversion ──────────────────────────────────────────────────

/**
 * Check if ffmpeg is available on the system.
 */
export function isFfmpegAvailable(): boolean {
  try {
    execSync("which ffmpeg", { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a WAV file to MP3 using ffmpeg.
 * Falls back to returning the WAV path if ffmpeg is not available.
 *
 * @returns The path to the output file (mp3 or wav)
 */
export async function convertToMp3(wavPath: string, mp3Path: string): Promise<string> {
  if (!isFfmpegAvailable()) {
    console.warn("[installer] ffmpeg not available — serving WAV instead of MP3");
    return wavPath;
  }

  return new Promise<string>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-i", wavPath,
      "-codec:a", "libmp3lame",
      "-qscale:a", "2",
      "-y", // overwrite
      mp3Path,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(mp3Path);
      } else {
        console.warn(`[installer] ffmpeg conversion failed, falling back to WAV: ${stderr.slice(0, 200)}`);
        resolve(wavPath);
      }
    });

    proc.on("error", () => {
      resolve(wavPath); // Fallback
    });
  });
}

// ── Install Status Cache ───────────────────────────────────────────────────

function loadInstallStatus(): InstallStatus {
  try {
    const content = fs.readFileSync(INSTALL_STATUS_FILE, "utf-8");
    return JSON.parse(content) as InstallStatus;
  } catch {
    return {};
  }
}

function saveInstallStatus(
  providerName: string,
  status: InstallStatus[string],
): void {
  const current = loadInstallStatus();
  current[providerName] = status;

  fs.mkdirSync(REVIEW_HUB_DIR, { recursive: true });
  fs.writeFileSync(INSTALL_STATUS_FILE, JSON.stringify(current, null, 2), "utf-8");
}

function clearInstallStatus(providerName: string): void {
  const current = loadInstallStatus();
  delete current[providerName];
  fs.mkdirSync(REVIEW_HUB_DIR, { recursive: true });
  fs.writeFileSync(INSTALL_STATUS_FILE, JSON.stringify(current, null, 2), "utf-8");
}

function isInstalledCached(providerName: string): boolean {
  const status = loadInstallStatus();
  return status[providerName]?.installed === true;
}
