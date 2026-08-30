export type VelarOSOfficialWebsiteMarket = 'cn' | 'global'
export type VelarOSAccountMarket = 'cn' | 'en'

export const VelarOSOfficialWebsiteOrigins: Readonly<Record<VelarOSOfficialWebsiteMarket, string>> =
  {
    cn: 'https://velaros.cn',
    global: 'https://global.velaros.cn',
  }

/**
 * Workbench 面向用户打开官网时的唯一市场判定入口。
 * Cloud API 地址独立管理，不允许把源站地址复用成公开网页地址。
 */
export function resolveVelarOSOfficialWebsiteMarket(input: {
  readonly configuredMarket?: string
  readonly locale: string
  readonly timeZone: string
}): VelarOSOfficialWebsiteMarket {
  if (input.configuredMarket === 'cn' || input.configuredMarket === 'global')
    return input.configuredMarket
  return input.locale.toLowerCase() === 'zh-cn' || input.timeZone === 'Asia/Shanghai'
    ? 'cn'
    : 'global'
}

export function resolveVelarOSOfficialWebsiteOrigin(
  market: VelarOSOfficialWebsiteMarket,
  accountMarket?: VelarOSAccountMarket
): string {
  if (accountMarket === 'cn') return VelarOSOfficialWebsiteOrigins.cn
  if (accountMarket === 'en') return VelarOSOfficialWebsiteOrigins.global
  return VelarOSOfficialWebsiteOrigins[market]
}

export function resolveVelarOSOfficialWebsiteUrl(
  market: VelarOSOfficialWebsiteMarket,
  pathname: string,
  accountMarket?: VelarOSAccountMarket
): string {
  return new URL(
    pathname,
    `${resolveVelarOSOfficialWebsiteOrigin(market, accountMarket)}/`
  ).toString()
}
