import { app } from "electron";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { logger } from "./logger.js";

/**
 * macOS 更新安装：解压替换 App 包 + 重启。
 *
 * 背景：CI 构建未配置 Apple 开发者证书（仅 electron-builder 默认的 ad-hoc 签名），
 * Squirrel.Mac 在安装阶段会做新旧包代码签名一致性校验，ad-hoc 签名必然不匹配，
 * 稳定报 `{"code":-1,"domain":"SQRLCodeSignatureErrorDomain"}`，未签名构建的
 * 自动更新因此永远装不上（发现/下载不受影响）。这里在 darwin 上绕过 Squirrel
 * 安装器：electron-updater 已把更新 zip 落在缓存目录，直接校验 sha512、解压、
 * 原子替换 App 包并重启。完整性由 latest-mac.yml 的 sha512 与 update-info.json
 * 的 fileName 共同保证，替代 Squirrel 的签名校验职责。Windows 仍走 NSIS 原链路。
 */

const STALE_OLD_BUNDLE_SUFFIX = ".app.old-zcode-update";

function execFileText(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} failed: ${error.message} ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 从包内 app-update.yml 读取 updaterCacheDirName；读不到时按观测值兜底。 */
function readUpdaterCacheDirName(): string {
  const fallback = "@zcodedesktop-updater";
  try {
    const updateYmlPath = path.join(process.resourcesPath, "app-update.yml");
    if (!existsSync(updateYmlPath)) return fallback;
    const content = readFileSync(updateYmlPath, "utf8") as string;
    const match = content.match(/^updaterCacheDirName:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    return match?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function verifyFileSha512(filePath: string, expectedSha512Base64: string): Promise<void> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(filePath), hash);
  const actual = hash.digest("base64");
  if (actual !== expectedSha512Base64) {
    throw new Error(`update zip sha512 mismatch: expected ${expectedSha512Base64}, got ${actual}`);
  }
}

function resolveCurrentAppBundleRoot(): string {
  // exe = <root>/Contents/MacOS/<executable>
  return path.resolve(path.dirname(path.dirname(path.dirname(app.getPath("exe")))));
}

async function readExtractedAppBundleVersion(appBundlePath: string): Promise<string> {
  const plist = path.join(appBundlePath, "Contents", "Info.plist");
  if (!existsSync(plist)) {
    throw new Error(`extracted update bundle missing Info.plist: ${plist}`);
  }
  const version = (
    await execFileText("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist])
  ).trim();
  if (!version) {
    throw new Error("extracted update bundle has empty CFBundleShortVersionString");
  }
  return version;
}

/** 清理历史替换残留的旧包（启动时 best-effort 调用，失败只记日志）。 */
export async function cleanupStaleMacUpdateBundles(): Promise<void> {
  if (process.platform !== "darwin" || !app.isPackaged) return;
  try {
    const appRoot = resolveCurrentAppBundleRoot();
    const stale = `${appRoot}${STALE_OLD_BUNDLE_SUFFIX}`;
    if (existsSync(stale)) {
      await fs.rm(stale, { recursive: true, force: true });
      logger.info("[auto-update] removed stale old app bundle after bundle-replace update");
    }
  } catch (error) {
    logger.warn("[auto-update] stale old app bundle cleanup failed:", error);
  }
}

/**
 * 用缓存中已下载的更新 zip 替换当前 App 包并重启。成功路径在函数内 relaunch +
 * exit 终止进程；任何校验或替换失败都抛错，由调用方走统一的更新失败收敛。
 */
export async function installMacUpdateByBundleReplacement(params: {
  expectedVersion: string;
}): Promise<void> {
  // Electron 41 的 app.getPath 已移除 "cache" 键；darwin 的用户缓存目录固定为
  // ~/Library/Caches（electron-updater 的 updaterCacheDirName 也落在其下）。
  const cachesRoot = path.join(app.getPath("home"), "Library", "Caches");
  const cacheRoot = path.join(cachesRoot, readUpdaterCacheDirName(), "pending");
  const infoPath = path.join(cacheRoot, "update-info.json");
  if (!existsSync(infoPath)) {
    throw new Error(`mac bundle replace aborted: pending update info missing at ${infoPath}`);
  }
  const updateInfo = JSON.parse(await fs.readFile(infoPath, "utf8")) as {
    fileName?: string;
    sha512?: string;
  };
  if (!updateInfo.fileName || !updateInfo.sha512) {
    throw new Error("mac bundle replace aborted: pending update info incomplete");
  }
  const zipPath = path.join(cacheRoot, updateInfo.fileName);
  if (!existsSync(zipPath)) {
    throw new Error(`mac bundle replace aborted: pending zip missing at ${zipPath}`);
  }

  logger.info(
    `[auto-update] mac bundle replace install start version=${params.expectedVersion} zip=${zipPath}`,
  );
  await verifyFileSha512(zipPath, updateInfo.sha512);

  const appRoot = resolveCurrentAppBundleRoot();
  const appRootDir = path.dirname(appRoot);
  const appName = path.basename(appRoot);
  // 暂存目录放在 App 同级卷上，保证 rename 原子性；ditto 保留符号链接与权限，
  // unzip 会破坏 .app 内的 symlink 结构。
  const stagingDir = path.join(appRootDir, `.zcode-update-staging-${Date.now()}`);
  const oldBundlePath = `${appRoot}${STALE_OLD_BUNDLE_SUFFIX}`;
  await fs.mkdir(stagingDir, { recursive: true });
  try {
    await execFileText("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir]);
    const extractedBundle = path.join(stagingDir, appName);
    if (!existsSync(extractedBundle)) {
      throw new Error(`mac bundle replace aborted: extracted bundle missing ${extractedBundle}`);
    }
    const extractedVersion = await readExtractedAppBundleVersion(extractedBundle);
    if (extractedVersion !== params.expectedVersion) {
      throw new Error(
        `mac bundle replace aborted: version mismatch extracted=${extractedVersion} expected=${params.expectedVersion}`,
      );
    }
    // 解压产物可能带 com.apple.quarantine（下载链路遗留），清掉避免下次启动被 Gatekeeper 拦。
    await execFileText("/usr/bin/xattr", ["-rd", "com.apple.quarantine", extractedBundle]).catch(
      () => undefined,
    );

    if (existsSync(oldBundlePath)) {
      await fs.rm(oldBundlePath, { recursive: true, force: true });
    }
    await fs.rename(appRoot, oldBundlePath);
    try {
      await fs.rename(extractedBundle, appRoot);
    } catch (error) {
      // 新包就位失败必须立即回滚，否则用户失去可用 App。
      await fs.rename(oldBundlePath, appRoot);
      throw error;
    }
    logger.info(
      `[auto-update] mac bundle replace applied version=${params.expectedVersion}; relaunching`,
    );
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }

  // 缓存中的更新 zip 已消费且包已替换；留着只会让缓存目录常驻 ~180MB。
  await fs.rm(zipPath, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

  app.relaunch();
  app.exit(0);
}
