import { useCallback, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import { resolveProviderFamilyDomainFromOAuthProvider } from "@zcode/shared";
import { useAlertDialog } from "@/hooks/useAlertDialog.js";
import { refreshAppSettingsSnapshot } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { setProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { applyCachedOAuthSessionRestoreResult } from "@/root/oauthCachedSessionRestore.js";
import { refreshLatestModelProviderFamilySelectionAfterLogin } from "@/root/oauthProviderFamilySelectionRefresh.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/** 可切换账号的一项：本地有登录档案时点击即切换，否则降级到统一登录入口。 */
interface AccountSwitchOption {
  provider: OAuthProviderMeta;
  persisted: boolean;
  active: boolean;
}

/**
 * 账号快捷切换（单活语义）。
 *
 * 跨 family（智谱 zai/bigmodel ↔ Kimi）凭据本来共存，切换只把 active provider 指回目标
 * family 已持久化的登录档案；域设置、连接选择、账号视图和用户展示态都复用登录后的既有
 * 链路刷新，不新造第二份账号状态。目标无档案时返回 login-required，由统一登录入口续接。
 */
export function useAccountSwitch() {
  // 账号凭据属于 app-global 事实：sidebar 位于 workspace 服务作用域内，远端 tab 会拿到远端 host，
  // 那里没有本机 OAuth 凭据，必须回到 base（本机）服务解析账号。
  const services = useBaseWorkspaceServices();
  const setUser = useZCodeStore((state) => state.setUser);
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const setOAuthError = useZCodeStore((state) => state.setOAuthError);
  const requestAlert = useAlertDialog();
  const { intl } = useZCodeIntl();
  const [options, setOptions] = useState<AccountSwitchOption[] | null>(null);
  const [switchingProvider, setSwitchingProvider] = useState<OAuthProviderId | null>(null);
  const switchingRef = useRef(false);

  /** 菜单类入口按需加载：enabled provider 列表 + 本地仍有档案的 provider + 当前 active。 */
  const loadAccountSwitchOptions = useCallback(async () => {
    try {
      const [providers, persistedProviders, activeProvider] = await Promise.all([
        services.oauthService.getProviders(),
        services.oauthService.listPersistedOAuthProviders(),
        services.oauthService.getActiveProvider(),
      ]);
      setOptions(
        providers.map((provider) => ({
          provider,
          persisted: persistedProviders.includes(provider.id),
          active: provider.id === activeProvider,
        })),
      );
    } catch (error) {
      // 读取失败只影响入口展示，不能把异常抛给菜单渲染；保留空列表避免重复弹错。
      logger.warn("[AccountSwitch] 加载可切换账号失败", { error });
      setOptions([]);
    }
  }, [services]);

  const switchAccount = useCallback(
    async (provider: OAuthProviderId) => {
      if (switchingRef.current) {
        return null;
      }
      switchingRef.current = true;
      setSwitchingProvider(provider);
      try {
        const result = await services.oauthService.switchAccountFamily(provider);
        if (result.kind === "login-required") {
          logger.info("[AccountSwitch] 目标账号无本地档案，转统一登录入口", { provider });
          requestLoginEntry(provider);
          return result;
        }

        const domain = resolveProviderFamilyDomainFromOAuthProvider(provider);
        if (domain) {
          await setProviderFamilyDomain(services.settingService, domain);
        }
        // 登录/登出都会清掉上一次流程的失败提示；切换改变了账号归属，旧错误不能继续留在展示态。
        setOAuthError(null);
        try {
          await refreshLatestModelProviderFamilySelectionAfterLogin({ provider, services });
        } catch (error) {
          // selectedKey 校正只影响默认连接方式展示，不能回滚已经生效的账号切换。
          logger.warn("[AccountSwitch] 切换账号后刷新 provider family selectedKey 失败", {
            provider,
            error,
          });
        }
        try {
          // Kimi family 不走 zhipu 权益刷新，账号视图必须显式刷新一次，避免设置页残留旧 family 状态。
          await services.providerSettingsService.refresh("account-switch");
        } catch (error) {
          logger.warn("[AccountSwitch] 切换账号后刷新账号视图失败", { provider, error });
        }
        try {
          // settingService 直接落盘不会广播；设置快照与登录后处理一样必须显式刷新。
          await refreshAppSettingsSnapshot(services.settingService);
        } catch (error) {
          logger.warn("[AccountSwitch] 切换账号后刷新 App settings 快照失败", { provider, error });
        }

        // 展示态按 active provider 的缓存档案恢复；JWT 失效等边界沿用启动恢复的既有提示与登录入口。
        const restoreResult = await services.oauthService.restoreCachedSessionState();
        if (restoreResult.status === "signed-out") {
          setUser(null);
        } else {
          await applyCachedOAuthSessionRestoreResult({
            result: restoreResult,
            setUser,
            requestAlert,
            onReauthenticationRequired: () => requestLoginEntry(),
            copy: {
              title: intl.formatMessage({ id: "login.expired.title" }),
              description: intl.formatMessage({ id: "login.expired.description" }),
              actionLabel: intl.formatMessage({ id: "login.expired.action" }),
            },
          });
        }
        logger.info("[AccountSwitch] 已切回持久化账号", { provider, domain });
        return result;
      } catch (error) {
        logger.error("[AccountSwitch] 切换账号失败", { provider, error });
        return null;
      } finally {
        switchingRef.current = false;
        setSwitchingProvider(null);
      }
    },
    [intl, requestAlert, requestLoginEntry, services, setOAuthError, setUser],
  );

  return {
    switchAccount,
    switchingProvider,
    accountSwitchOptions: options,
    loadAccountSwitchOptions,
  };
}
