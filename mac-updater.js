const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const path = require('path');

const OWNER = 'LDCODES12';
const REPO = 'sleepy-pet';
const PRODUCT_NAME = 'Sleepy Pet';
const BUNDLE_ID = 'com.sleepypet.app';
const LATEST_MAC_YML_URL = `https://github.com/${OWNER}/${REPO}/releases/latest/download/latest-mac.yml`;
const PENDING_DIR = 'pending-mac-update';
const STALE_PREFIX = `${PENDING_DIR}.stale-`;

function createMacUpdater({ app, Notification, logger = console, onStateChange = () => {} }) {
  let state = {
    status: 'idle',
    version: null,
    scriptPath: null,
    newAppPath: null,
    targetAppPath: getCurrentAppBundlePath(app),
    logPath: path.join(app.getPath('userData'), 'mac-updater.log'),
    lastError: null,
    lastCheckedAt: null
  };
  let checkPromise = null;
  let installStarted = false;

  function setState(nextState) {
    state = { ...state, ...nextState };
    onStateChange(getState());
  }

  async function cleanStaleStaging() {
    // Called at launch (and before a new download) to make sure no leftover
    // fragment from a prior install cycle blocks the next staging attempt.
    // Uses a move-aside fallback when rm fails (e.g. file held open by this
    // process via an APFS clone) so the `pending-mac-update` path is always
    // clear for the next download even if individual files can't be removed
    // right away.
    const userDataDir = app.getPath('userData');
    let entries = [];
    try {
      entries = await fsp.readdir(userDataDir);
    } catch (error) {
      logger.warn(`cleanStaleStaging: could not read userData: ${error.message}`);
      return;
    }

    for (const entry of entries) {
      if (entry !== PENDING_DIR && !entry.startsWith(STALE_PREFIX)) continue;
      const target = path.join(userDataDir, entry);
      await removeOrMoveAside(target, logger);
    }
  }

  async function checkForUpdates({ silent = true } = {}) {
    if (checkPromise) return checkPromise;
    if (state.status === 'ready') {
      // Already have an update staged — don't re-download.
      return getState();
    }

    checkPromise = (async () => {
      if (!shouldRunUpdater(app)) {
        logger.info('Skipping custom mac updater because the app is not packaged');
        return null;
      }

      setState({ status: 'checking', lastError: null });
      const baseFeedUrl = process.env.SLEEPY_PET_UPDATE_FEED_URL || LATEST_MAC_YML_URL;
      // Cache-bust the feed so we don't get a stale redirect from any
      // intermediate cache. The zip URL is derived from baseFeedUrl (no
      // cache-buster) so the asset download stays clean.
      const fetchUrl = appendCacheBuster(baseFeedUrl);
      logger.info(`Checking for updates at ${baseFeedUrl}`);
      const latest = parseLatestMacYml((await requestBuffer(fetchUrl)).toString('utf8'));
      setState({ lastCheckedAt: new Date().toISOString() });
      logger.info(`Feed reports latest=${latest.version} (current=${app.getVersion()})`);

      if (compareVersions(latest.version, app.getVersion()) <= 0) {
        setState({ status: 'idle', version: null });
        return null;
      }

      setState({ status: 'downloading', version: latest.version });
      const preparedUpdate = await downloadAndPrepareUpdate(app, latest, baseFeedUrl, logger);
      setState({
        status: 'ready',
        version: latest.version,
        scriptPath: preparedUpdate.scriptPath,
        newAppPath: preparedUpdate.newAppPath,
        targetAppPath: preparedUpdate.targetAppPath,
        logPath: preparedUpdate.logPath
      });

      if (!silent && Notification?.isSupported?.()) {
        new Notification({
          title: `${PRODUCT_NAME} update ready`,
          body: `Version ${latest.version} will install when you quit ${PRODUCT_NAME}.`
        }).show();
      }

      return getState();
    })().catch(error => {
      const msg = error?.stack || String(error);
      logger.warn(`Custom mac updater failed: ${msg}`);
      setState({ status: 'error', lastError: String(error?.message || error) });
      return null;
    }).finally(() => {
      checkPromise = null;
    });

    return checkPromise;
  }

  function installOnQuit() {
    if (state.status !== 'ready' || installStarted) return false;
    installStarted = true;
    spawnInstaller(app, state, logger);
    return true;
  }

  function installNow() {
    if (!installOnQuit()) return false;
    app.quit();
    return true;
  }

  function getState() {
    return { ...state };
  }

  return {
    checkForUpdates,
    cleanStaleStaging,
    getState,
    installNow,
    installOnQuit
  };
}

function shouldRunUpdater(app) {
  return process.platform === 'darwin' && (app.isPackaged || process.env.SLEEPY_PET_FORCE_MAC_UPDATER === '1');
}

// Try to remove a path; if rm fails (commonly because a file in the tree is
// still held open via an APFS clone — the exact bug that bit 1.2.8→1.2.9),
// atomically rename it out of the way so the canonical path is free for the
// next staging attempt. A later launch, after the holding process exits, can
// clean the stale-renamed directory.
async function removeOrMoveAside(target, logger) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
    return;
  } catch (rmError) {
    const aside = `${target}.stale-${Date.now()}`;
    try {
      await fsp.rename(target, aside);
      logger.warn(`Could not remove ${path.basename(target)} (${rmError.code || rmError.message}); moved aside to ${path.basename(aside)}`);
      // Best-effort second pass; if it still fails, next launch will retry.
      try {
        await fsp.rm(aside, { recursive: true, force: true });
      } catch {
        // leave the aside path for a later launch to clean up
      }
    } catch (renameError) {
      logger.warn(`Could not clean or move ${path.basename(target)}: rm=${rmError.message} rename=${renameError.message}`);
    }
  }
}

async function downloadAndPrepareUpdate(app, latest, feedUrl, logger) {
  const updateRoot = path.join(app.getPath('userData'), PENDING_DIR);
  const extractDir = path.join(updateRoot, 'extracted');
  const zipPath = path.join(updateRoot, latest.path);
  const targetAppPath = getCurrentAppBundlePath(app);
  const logPath = path.join(app.getPath('userData'), 'mac-updater.log');

  await removeOrMoveAside(updateRoot, logger);
  await fsp.mkdir(extractDir, { recursive: true });

  const zipUrl = resolveAssetUrl(feedUrl, latest.path);
  logger.info(`Downloading mac update ${latest.version} from ${zipUrl}`);
  await downloadFile(zipUrl, zipPath, latest.sha512);
  logger.info(`Downloaded ${latest.path} (${latest.sha512.slice(0, 12)}...) to ${zipPath}`);

  await runCommand('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir]);

  const newAppPath = await findAppBundle(extractDir);
  const [bundleId, bundleVersion] = await Promise.all([
    readPlistValue(path.join(newAppPath, 'Contents', 'Info.plist'), 'CFBundleIdentifier'),
    readPlistValue(path.join(newAppPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString')
  ]);

  if (bundleId !== BUNDLE_ID) {
    throw new Error(`Downloaded app bundle id was ${bundleId}, expected ${BUNDLE_ID}`);
  }

  if (compareVersions(bundleVersion, app.getVersion()) <= 0) {
    throw new Error(`Downloaded app version ${bundleVersion} is not newer than ${app.getVersion()}`);
  }

  const scriptPath = path.join(updateRoot, 'install-mac-update.sh');
  await fsp.writeFile(scriptPath, buildInstallerScript(), { mode: 0o755 });
  logger.info(`Update ${latest.version} ready; installer at ${scriptPath}`);

  return { scriptPath, newAppPath, targetAppPath, logPath };
}

function spawnInstaller(app, state, logger) {
  const child = spawn('/bin/bash', [
    state.scriptPath,
    String(process.pid),
    state.newAppPath,
    state.targetAppPath,
    state.logPath
  ], {
    detached: true,
    stdio: 'ignore'
  });

  child.unref();
  logger.info(`Spawned mac update installer for ${state.version}`);
}

function buildInstallerScript() {
  // The cleanup change vs prior versions: move UPDATE_ROOT aside to a
  // timestamped "stale" sibling BEFORE doing the rm. That way, even if the
  // newly-launched app holds a file open inside the tree (APFS clone behavior
  // has bitten us), the canonical `pending-mac-update` path is immediately
  // free for the next launch's update check to use. A later launch will
  // finish cleaning the stale sibling.
  return `#!/bin/bash
set -euo pipefail

APP_PID="$1"
NEW_APP="$2"
TARGET_APP="$3"
LOG_PATH="$4"
BACKUP_APP="\${TARGET_APP}.previous-update"
UPDATE_ROOT="$(cd "$(dirname "$0")" && pwd)"
STASH_ROOT="\${UPDATE_ROOT}.stale-$(date +%s)"

{
  echo "[$(date)] Waiting for Sleepy Pet process \${APP_PID} to exit"
  for _ in $(seq 1 90); do
    if ! kill -0 "\${APP_PID}" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if kill -0 "\${APP_PID}" 2>/dev/null; then
    echo "[$(date)] Timed out waiting for Sleepy Pet to quit"
    exit 1
  fi

  TARGET_PARENT="$(dirname "\${TARGET_APP}")"
  if [ ! -w "\${TARGET_PARENT}" ]; then
    echo "[$(date)] Cannot write to \${TARGET_PARENT}"
    exit 1
  fi

  restore_backup() {
    if [ ! -d "\${TARGET_APP}" ] && [ -d "\${BACKUP_APP}" ]; then
      mv "\${BACKUP_APP}" "\${TARGET_APP}"
    fi
  }
  trap restore_backup ERR

  rm -rf "\${BACKUP_APP}"
  if [ -d "\${TARGET_APP}" ]; then
    mv "\${TARGET_APP}" "\${BACKUP_APP}"
  fi

  /usr/bin/ditto "\${NEW_APP}" "\${TARGET_APP}"
  /usr/bin/xattr -dr com.apple.quarantine "\${TARGET_APP}" 2>/dev/null || true
  if [ "\${SLEEPY_PET_INSTALLER_SKIP_OPEN:-}" != "1" ]; then
    /usr/bin/open "\${TARGET_APP}" || true
  fi
  rm -rf "\${BACKUP_APP}"
  echo "[$(date)] Installed Sleepy Pet update"

  # Move the whole staging tree aside before trying to remove it. Rename is
  # atomic and works even when children are mmap'd by the just-opened new
  # process — so the canonical path is free for the next update check. Then
  # best-effort rm the aside; if it doesn't fully succeed, the next launch
  # will finish cleaning any STALE_PREFIX siblings it finds.
  cd /
  if mv "\${UPDATE_ROOT}" "\${STASH_ROOT}" 2>/dev/null; then
    rm -rf "\${STASH_ROOT}" 2>/dev/null || echo "[$(date)] Left \${STASH_ROOT} for next-launch cleanup"
  else
    rm -rf "\${UPDATE_ROOT}" 2>/dev/null || echo "[$(date)] Could not remove \${UPDATE_ROOT}; next launch will retry"
  fi
} >> "\${LOG_PATH}" 2>&1
`;
}

function getCurrentAppBundlePath(app) {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

function appendCacheBuster(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${Date.now()}`;
}

function parseLatestMacYml(contents) {
  const version = readYamlScalar(contents, 'version');
  const updatePath = readYamlScalar(contents, 'path');
  const sha512 = readYamlScalar(contents, 'sha512');

  if (!version || !updatePath || !sha512) {
    throw new Error('latest-mac.yml did not include version, path, and sha512');
  }

  return { version, path: updatePath, sha512 };
}

function readYamlScalar(contents, key) {
  const match = contents.match(new RegExp(`^${key}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'));
  return match ? match[1].trim() : null;
}

function resolveAssetUrl(feedUrl, assetPath) {
  const base = new URL(feedUrl);
  base.search = '';
  const segments = base.pathname.split('/');
  segments[segments.length - 1] = encodeURIComponent(assetPath);
  base.pathname = segments.join('/');
  return base.toString();
}

function compareVersions(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  return 0;
}

function normalizeVersion(version) {
  return String(version).split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
}

function requestBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount > 5) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        resolve(requestBuffer(new URL(response.headers.location, url).toString(), redirectCount + 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`GET ${url} failed with ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('error', reject);
  });
}

function downloadFile(url, destination, expectedSha512, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount > 5) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        resolve(downloadFile(new URL(response.headers.location, url).toString(), destination, expectedSha512, redirectCount + 1));
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`GET ${url} failed with ${response.statusCode}`));
        return;
      }

      const hash = crypto.createHash('sha512');
      const file = fs.createWriteStream(destination);

      response.on('data', chunk => hash.update(chunk));
      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          const actualSha512 = hash.digest('base64');
          if (actualSha512 !== expectedSha512) {
            reject(new Error(`Downloaded update checksum mismatch: ${actualSha512}`));
            return;
          }
          resolve();
        });
      });

      file.on('error', reject);
    });

    request.on('error', reject);
  });
}

function isRedirect(statusCode) {
  return statusCode >= 300 && statusCode < 400;
}

async function findAppBundle(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name === `${PRODUCT_NAME}.app`) {
      return entryPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findAppBundle(path.join(root, entry.name)).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (found) return found;
  }

  throw new Error(`Could not find ${PRODUCT_NAME}.app in downloaded update`);
}

function readPlistValue(plistPath, key) {
  return runCommand('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

module.exports = {
  createMacUpdater,
  _private: {
    compareVersions,
    parseLatestMacYml,
    resolveAssetUrl,
    appendCacheBuster
  }
};
