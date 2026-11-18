/**
 * DeepSeek meter — statusbar chip for the live API balance, the current
 * context-window load and today's token/cost totals.
 *
 * Data comes from this plugin's own Python backend (`dashboard/plugin_api.py`
 * → `/api/plugins/deepseek-meter/stats`), so the API key never touches the
 * renderer. Every visible string is looked up with `usePluginI18n`, which
 * follows the app locale (system language) and falls back to `en`.
 */

import { usePluginI18n, useQuery, useValue, host } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'deepseek-meter'
const REFRESH_MS = 20000

let api = null

// Tailwind does not scan disk plugins: only layout lives here.
const CSS = `
.dsm-bar{display:flex;align-items:center;gap:0;height:100%}
.dsm-chip{display:inline-flex;align-items:center;gap:5px;height:100%;padding:0 6px;font-size:11px;line-height:1;
  font-variant-numeric:tabular-nums;color:var(--ui-text-tertiary);background:transparent;border:0;cursor:pointer;
  transition:background .12s ease,color .12s ease;white-space:nowrap}
.dsm-chip:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.dsm-chip[data-tone=ok] .dsm-dot{background:var(--ui-accent)}
.dsm-chip[data-tone=stale] .dsm-dot{background:#d9a441}
.dsm-chip[data-tone=down] .dsm-dot{background:#d9534f}
.dsm-dot{width:5px;height:5px;border-radius:999px;flex-shrink:0;background:var(--ui-text-quaternary)}
.dsm-sep{color:var(--ui-text-quaternary);opacity:.5}
.dsm-ctx-hot{color:#d9a441;font-weight:600}
.dsm-track{position:relative;height:4px;margin:6px 0 5px;border-radius:999px;overflow:hidden;
  background:var(--ui-stroke-secondary)}
.dsm-fill{display:block;height:100%;border-radius:999px;background:var(--ui-accent);transition:width .25s ease}
.dsm-track[data-tone=stale] .dsm-fill{background:#d9a441}
.dsm-track[data-tone=down] .dsm-fill{background:#d9534f}
.dsm-caption-inline{font-size:10.5px;color:var(--ui-text-quaternary)}
.dsm-pop{position:fixed;right:14px;bottom:34px;z-index:2147483000;display:block}
.dsm-panel{box-sizing:border-box;width:auto;max-width:min(320px,calc(100vw - 32px));padding:0;border:0;
  background:transparent;box-shadow:none;overflow:visible}
.dsm-body{box-sizing:border-box;width:288px;max-width:100%;padding:14px 19px 15px;
  font-size:11.5px;line-height:1.5;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums;
  max-height:min(70vh,560px);overflow:auto;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:var(--ui-stroke-secondary) transparent;
  border-radius:10px;border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-elevated,var(--card))}
.dsm-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding-bottom:7px;
  border-bottom:1px solid var(--ui-stroke-secondary);margin-bottom:7px}
.dsm-title{font-size:11.5px;font-weight:600;color:var(--ui-text-primary)}
.dsm-updated{font-size:10.5px;color:var(--ui-text-quaternary)}
.dsm-row{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:16px;align-items:baseline;
  min-height:18px}
.dsm-row-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text-tertiary)}
.dsm-row-value{color:var(--ui-text-primary);text-align:right;white-space:nowrap}
.dsm-strong{font-weight:600}
.dsm-group{margin-top:8px;padding-top:8px;border-top:1px solid var(--ui-stroke-secondary)}
.dsm-caption{margin-top:8px;padding-top:7px;border-top:1px solid var(--ui-stroke-secondary);
  font-size:10.5px;color:var(--ui-text-quaternary)}
.dsm-error{margin-top:8px;font-size:10.5px;color:#d9534f;word-break:break-word}
`

// ── locales ────────────────────────────────────────────────────────────────
// `usePluginI18n` resolves the app locale (system language), then `en`, then
// the raw key. Values may be strings or interpolators.

const LOCALES = {
  en: {
    title: 'DeepSeek',
    balance: 'Balance',
    toppedUp: 'Topped up',
    granted: 'Granted',
    updated: 'Updated',
    account: 'Account',
    unavailable: 'unavailable',
    context: 'Context',
    today: 'Today',
    inOut: 'In / out',
    fromCache: 'From cache',
    cost: 'Cost',
    week: 'Last 7 days',
    allTime: 'All time',
    session: 'This chat',
    tokens: count => `${count} tokens`,
    ctxRange: (used, max) => `${used} / ${max} tokens`,
    calls: 'Requests',
    callsLine: (calls, chats) => `${calls} calls · ${chats} chats`,
    live: 'live',
    stale: 'cached',
    noData: 'no data',
    caption: pct => `auto-compress at ${pct}% · refresh 20 s`,
    captionOff: 'auto-compress off · refresh 20 s',
    captionUnknown: 'refresh 20 s',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · ${tokens} tokens today${pct === null ? '' : ` · context ${pct}%`}`,
    loading: 'DeepSeek: loading…',
    errorPrefix: message => `DeepSeek meter: ${message}`,
    balanceError: message => `Balance: ${message}`,
    usageError: message => `Usage: ${message}`
  },
  ru: {
    title: 'DeepSeek',
    balance: 'Баланс',
    toppedUp: 'Пополнено',
    granted: 'Грант',
    updated: 'Обновлено',
    account: 'Аккаунт',
    unavailable: 'недоступен',
    context: 'Контекст',
    today: 'Сегодня',
    inOut: 'Вход / выход',
    fromCache: 'Из кэша',
    cost: 'Стоимость',
    week: '7 дней',
    allTime: 'Всего',
    session: 'Эта сессия',
    calls: 'Запросов',
    tokens: count => `${count} токенов`,
    ctxRange: (used, max) => `${used} / ${max} токенов`,
    callsLine: (calls, chats) => `${calls} запросов · ${chats} сесс.`,
    live: 'live',
    stale: 'кэш',
    noData: 'нет данных',
    caption: pct => `авто-сжатие при ${pct}% · обновление 20 с`,
    captionOff: 'авто-сжатие выкл. · обновление 20 с',
    captionUnknown: 'обновление 20 с',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · сегодня ${tokens} токенов${pct === null ? '' : ` · контекст ${pct}%`}`,
    loading: 'DeepSeek: загрузка…',
    errorPrefix: message => `DeepSeek: ${message}`,
    balanceError: message => `Баланс: ${message}`,
    usageError: message => `Статистика: ${message}`
  },
  uk: {
    title: 'DeepSeek',
    balance: 'Баланс',
    toppedUp: 'Поповнено',
    granted: 'Грант',
    updated: 'Оновлено',
    account: 'Обліковий запис',
    unavailable: 'недоступний',
    context: 'Контекст',
    today: 'Сьогодні',
    inOut: 'Вхід / вихід',
    fromCache: 'З кешу',
    cost: 'Вартість',
    week: '7 днів',
    allTime: 'Усього',
    session: 'Цей сеанс',
    tokens: count => `${count} токенів`,
    ctxRange: (used, max) => `${used} / ${max} токенів`,
    calls: 'Запитів',
    callsLine: (calls, chats) => `запитів: ${calls} · сеансів: ${chats}`,
    live: 'live',
    stale: 'кеш',
    noData: 'немає даних',
    caption: pct => `авто-стиснення при ${pct}% · оновлення 20 с`,
    captionOff: 'авто-стиснення вимк. · оновлення 20 с',
    captionUnknown: 'оновлення 20 с',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · сьогодні ${tokens} токенів${pct === null ? '' : ` · контекст ${pct}%`}`,
    loading: 'DeepSeek: завантаження…',
    errorPrefix: message => `DeepSeek: ${message}`,
    balanceError: message => `Баланс: ${message}`,
    usageError: message => `Статистика: ${message}`
  },
  es: {
    title: 'DeepSeek',
    balance: 'Saldo',
    toppedUp: 'Recargado',
    granted: 'Bonificado',
    updated: 'Actualizado',
    account: 'Cuenta',
    unavailable: 'no disponible',
    context: 'Contexto',
    today: 'Hoy',
    inOut: 'Entrada / salida',
    fromCache: 'Desde caché',
    cost: 'Coste',
    week: 'Últimos 7 días',
    allTime: 'Total',
    session: 'Este chat',
    tokens: count => `${count} tokens`,
    ctxRange: (used, max) => `${used} / ${max} tokens`,
    calls: 'Peticiones',
    callsLine: (calls, chats) => `${calls} llamadas · ${chats} chats`,
    live: 'live',
    stale: 'caché',
    noData: 'sin datos',
    caption: pct => `autocompresión al ${pct}% · actualización 20 s`,
    captionOff: 'autocompresión off · actualización 20 s',
    captionUnknown: 'actualización 20 s',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · ${tokens} tokens hoy${pct === null ? '' : ` · contexto ${pct}%`}`,
    loading: 'DeepSeek: cargando…',
    errorPrefix: message => `DeepSeek: ${message}`,
    balanceError: message => `Saldo: ${message}`,
    usageError: message => `Estadísticas: ${message}`
  },
  de: {
    title: 'DeepSeek',
    balance: 'Guthaben',
    toppedUp: 'Aufgeladen',
    granted: 'Gutschrift',
    updated: 'Aktualisiert',
    account: 'Konto',
    unavailable: 'nicht verfügbar',
    context: 'Kontext',
    today: 'Heute',
    inOut: 'Eingang / Ausgang',
    fromCache: 'Aus dem Cache',
    cost: 'Kosten',
    week: 'Letzte 7 Tage',
    allTime: 'Gesamt',
    session: 'Dieser Chat',
    tokens: count => `${count} Token`,
    ctxRange: (used, max) => `${used} / ${max} Token`,
    calls: 'Anfragen',
    callsLine: (calls, chats) => `${calls} Anfragen · ${chats} Chats`,
    live: 'live',
    stale: 'Cache',
    noData: 'keine Daten',
    caption: pct => `Auto-Komprimierung bei ${pct}% · Aktualisierung 20 s`,
    captionOff: 'Auto-Komprimierung aus · Aktualisierung 20 s',
    captionUnknown: 'Aktualisierung 20 s',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · heute ${tokens} Token${pct === null ? '' : ` · Kontext ${pct}%`}`,
    loading: 'DeepSeek: lädt…',
    errorPrefix: message => `DeepSeek: ${message}`,
    balanceError: message => `Guthaben: ${message}`,
    usageError: message => `Statistik: ${message}`
  },
  fr: {
    title: 'DeepSeek',
    balance: 'Solde',
    toppedUp: 'Rechargé',
    granted: 'Offert',
    updated: 'Actualisé',
    account: 'Compte',
    unavailable: 'indisponible',
    context: 'Contexte',
    today: "Aujourd'hui",
    inOut: 'Entrée / sortie',
    fromCache: 'Depuis le cache',
    cost: 'Coût',
    week: '7 derniers jours',
    allTime: 'Total',
    session: 'Cette conversation',
    tokens: count => `${count} jetons`,
    ctxRange: (used, max) => `${used} / ${max} jetons`,
    calls: 'Requêtes',
    callsLine: (calls, chats) => `${calls} requêtes · ${chats} conversations`,
    live: 'live',
    stale: 'cache',
    noData: 'aucune donnée',
    caption: pct => `compression auto à ${pct} % · actualisation 20 s`,
    captionOff: 'compression auto off · actualisation 20 s',
    captionUnknown: 'actualisation 20 s',
    tip: (money, tokens, pct) => `DeepSeek : ${money} · ${tokens} jetons aujourd'hui${pct === null ? '' : ` · contexte ${pct} %`}`,
    loading: 'DeepSeek : chargement…',
    errorPrefix: message => `DeepSeek : ${message}`,
    balanceError: message => `Solde : ${message}`,
    usageError: message => `Statistiques : ${message}`
  },
  zh: {
    title: 'DeepSeek',
    balance: '余额',
    toppedUp: '已充值',
    granted: '赠送',
    updated: '更新于',
    account: '账户',
    unavailable: '不可用',
    context: '上下文',
    today: '今日',
    inOut: '输入 / 输出',
    fromCache: '来自缓存',
    cost: '费用',
    week: '最近 7 天',
    allTime: '总计',
    session: '当前会话',
    tokens: count => `${count} tokens`,
    ctxRange: (used, max) => `${used} / ${max} tokens`,
    calls: '请求数',
    callsLine: (calls, chats) => `${calls} 次请求 · ${chats} 个会话`,
    live: 'live',
    stale: '缓存',
    noData: '无数据',
    caption: pct => `上下文达 ${pct}% 自动压缩 · 每 20 秒刷新`,
    captionOff: '自动压缩已关闭 · 每 20 秒刷新',
    captionUnknown: '每 20 秒刷新',
    tip: (money, tokens, pct) => `DeepSeek：${money} · 今日 ${tokens} tokens${pct === null ? '' : ` · 上下文 ${pct}%`}`,
    loading: 'DeepSeek：加载中…',
    errorPrefix: message => `DeepSeek：${message}`,
    balanceError: message => `余额：${message}`,
    usageError: message => `统计：${message}`
  },
  ja: {
    title: 'DeepSeek',
    balance: '残高',
    toppedUp: 'チャージ済み',
    granted: '付与',
    updated: '更新',
    account: 'アカウント',
    unavailable: '利用不可',
    context: 'コンテキスト',
    today: '今日',
    inOut: '入力 / 出力',
    fromCache: 'キャッシュから',
    cost: 'コスト',
    week: '過去 7 日間',
    allTime: '合計',
    session: 'このセッション',
    tokens: count => `${count} トークン`,
    ctxRange: (used, max) => `${used} / ${max} トークン`,
    calls: 'リクエスト',
    callsLine: (calls, chats) => `${calls} 回 · ${chats} セッション`,
    live: 'live',
    stale: 'キャッシュ',
    noData: 'データなし',
    caption: pct => `コンテキスト ${pct}% で自動圧縮 · 20 秒ごとに更新`,
    captionOff: '自動圧縮オフ · 20 秒ごとに更新',
    captionUnknown: '20 秒ごとに更新',
    tip: (money, tokens, pct) => `DeepSeek: ${money} · 今日 ${tokens} トークン${pct === null ? '' : ` · コンテキスト ${pct}%`}`,
    loading: 'DeepSeek: 読み込み中…',
    errorPrefix: message => `DeepSeek: ${message}`,
    balanceError: message => `残高: ${message}`,
    usageError: message => `使用状況: ${message}`
  }
}

// ── formatting ─────────────────────────────────────────────────────────────

function formatMoney(value, currency) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '—'
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  const digits = Math.abs(amount) >= 100 ? 1 : 2
  const shown = amount.toFixed(digits)
  return symbol ? symbol + shown : shown + ' ' + (currency || '')
}

function formatTokens(count) {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + 'M'
  if (value >= 1e3) return (value / 1e3).toFixed(value >= 1e5 ? 0 : 1) + 'k'
  return String(Math.round(value))
}

function formatClock(seconds) {
  if (!seconds) return '—'
  try {
    return new Date(Number(seconds) * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return '—'
  }
}

function pickBalance(balance) {
  const infos = Array.isArray(balance?.infos) ? balance.infos : []
  if (!infos.length) return null
  return infos.find(info => Number(info.total) > 0) || infos[0]
}

function contextPercent(sessionUsage) {
  const percent = sessionUsage?.context_percent
  if (percent != null && Number.isFinite(Number(percent))) {
    return Math.max(0, Math.min(100, Number(percent)))
  }
  const used = Number(sessionUsage?.context_used || 0)
  const max = Number(sessionUsage?.context_max || 0)
  if (used > 0 && max > 0) return Math.max(0, Math.min(100, (used / max) * 100))
  return null
}

function captionText(t, compression) {
  if (!compression || compression.enabled === null) return t('captionUnknown')
  if (!compression.enabled) return t('captionOff')
  return t('caption', compression.threshold_pct ?? 50)
}

function useStats() {
  return useQuery({
    queryKey: [ID, 'stats'],
    queryFn: () => api.rest('/stats'),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: 1,
    staleTime: 15000
  })
}

function toneFor(balance, usage, error) {
  if (error || (balance && balance.ok === false) || (usage && usage.ok === false)) return 'down'
  if (balance?.stale) return 'stale'
  return 'ok'
}

// ── components ─────────────────────────────────────────────────────────────

function Labelled({ label, value, strong }) {
  return jsxs('div', { className: 'dsm-row', children: [
    jsx('span', { className: 'dsm-row-label', children: label }),
    jsx('span', { className: strong ? 'dsm-row-value dsm-strong' : 'dsm-row-value', children: value })
  ] })
}

function Panel({ data, error, fetchedAt, sessionUsage }) {
  const t = usePluginI18n(ID)
  const balance = data?.balance
  const usage = data?.usage
  const info = pickBalance(balance)
  const today = usage?.today
  const week = usage?.last_7d
  const all = usage?.all_time
  const contextUsed = Number(sessionUsage?.context_used || 0)
  const contextMax = Number(sessionUsage?.context_max || 0)
  const rows = []

  if (info) {
    rows.push(jsx(Labelled, { label: t('balance'), value: formatMoney(info.total, info.currency), strong: true }))
    rows.push(jsx(Labelled, { label: t('toppedUp'), value: formatMoney(info.topped_up, info.currency) }))
    rows.push(jsx(Labelled, { label: t('granted'), value: formatMoney(info.granted, info.currency) }))
  } else {
    rows.push(jsx(Labelled, { label: t('balance'), value: '—', strong: true }))
  }
  rows.push(jsx(Labelled, { label: t('updated'), value: formatClock(fetchedAt || balance?.fetched_at) }))
  if (balance?.is_available === false) {
    rows.push(jsx(Labelled, { label: t('account'), value: t('unavailable') }))
  }

  // ── context window ───────────────────────────────────────────────
  const pct = contextPercent(sessionUsage)
  const contextTone = pct == null ? 'ok' : pct >= 90 ? 'down' : pct >= 70 ? 'stale' : 'ok'
  rows.push(jsxs('div', { className: 'dsm-group', children: [
    jsxs('div', { className: 'dsm-row', children: [
      jsx('span', { className: 'dsm-row-label', children: t('context') }),
      jsx('span', { className: 'dsm-row-value dsm-strong', children: pct == null ? '—' : Math.round(pct) + '%' })
    ] }),
    pct == null
      ? null
      : jsx('div', { className: 'dsm-track', 'data-tone': contextTone, children: jsx('span', {
        className: 'dsm-fill',
        style: { width: Math.max(2, pct) + '%' }
      }) }),
    contextMax
      ? jsx('div', { className: 'dsm-caption-inline', children: t('ctxRange', formatTokens(contextUsed), formatTokens(contextMax)) })
      : null
  ] }))

  if (today) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, { label: t('today'), value: t('tokens', formatTokens(today.total)), strong: true }),
      jsx(Labelled, { label: t('inOut'), value: formatTokens(today.input) + ' / ' + formatTokens(today.output) }),
      today.cached ? jsx(Labelled, { label: t('fromCache'), value: formatTokens(today.cached) }) : null,
      jsx(Labelled, { label: t('cost'), value: '~$' + Number(today.cost_usd || 0).toFixed(4) }),
      jsx(Labelled, { label: t('calls'), value: t('callsLine', String(today.calls || 0), String(today.sessions || 0)) })
    ] }))
  }

  if (week || all) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, {
        label: t('week'),
        value: week ? formatTokens(week.total) + ' · ~$' + Number(week.cost_usd || 0).toFixed(3) : '—'
      }),
      jsx(Labelled, {
        label: t('allTime'),
        value: all ? formatTokens(all.total) + ' · ~$' + Number(all.cost_usd || 0).toFixed(3) : '—'
      })
    ] }))
  }

  if (sessionUsage) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, { label: t('session'), value: t('tokens', formatTokens(sessionUsage.total)), strong: true }),
      jsx(Labelled, { label: t('inOut'), value: formatTokens(sessionUsage.input) + ' / ' + formatTokens(sessionUsage.output) }),
      sessionUsage.cost_usd
        ? jsx(Labelled, { label: t('cost'), value: '~$' + Number(sessionUsage.cost_usd).toFixed(4) })
        : null
    ] }))
  }

  if (usage?.models?.length) {
    rows.push(jsxs('div', { className: 'dsm-group', children: usage.models.slice(0, 4).map(model =>
      jsx(Labelled, {
        label: model.model,
        value: formatTokens(model.input + model.output) + ' · ~$' + Number(model.cost_usd || 0).toFixed(4)
      }, model.model)
    ) }))
  }

  if (error) rows.push(jsx('div', { className: 'dsm-error', children: String(error.message || error) }))
  if (balance?.ok === false) {
    rows.push(jsx('div', { className: 'dsm-error', children: t('balanceError', String(balance.error || '—')) }))
  }
  if (usage?.ok === false) {
    rows.push(jsx('div', { className: 'dsm-error', children: t('usageError', String(usage.error || '—')) }))
  }
  rows.push(jsx('div', { className: 'dsm-caption', children: captionText(t, data?.compression) }))

  return jsxs('div', { className: 'dsm-body', children: [
    jsxs('div', { className: 'dsm-head', children: [
      jsx('span', { className: 'dsm-title', children: t('title') }),
      jsx('span', {
        className: 'dsm-updated',
        children: balance?.stale ? t('stale') : balance?.ok === false ? t('noData') : t('live')
      })
    ] }),
    rows
  ] })
}

function Meter() {
  const t = usePluginI18n(ID)
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const query = useStats()
  const sessionUsage = useValue(host.state.focusedUsage)
  const data = query.data
  const info = pickBalance(data?.balance)
  const today = data?.usage?.today
  const tone = toneFor(data?.balance, data?.usage, query.error)
  const pct = contextPercent(sessionUsage)
  const pctLabel = pct == null ? null : Math.round(pct)
  const tip = query.error
    ? t('errorPrefix', String(query.error.message || query.error))
    : info
      ? t('tip', formatMoney(info.total, info.currency), formatTokens(today?.total), pctLabel)
      : t('loading')

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return jsxs('div', { className: 'dsm-bar', ref: rootRef, children: [
    jsx('button', {
      type: 'button',
      className: 'dsm-chip',
      'data-tone': tone,
      title: tip,
      'aria-label': tip,
      'aria-expanded': open,
      onClick: () => setOpen(value => !value),
      children: [
        jsx('span', { className: 'dsm-dot', 'aria-hidden': true }),
        jsx('span', { children: info ? formatMoney(info.total, info.currency) : '—' }),
        jsx('span', { className: 'dsm-sep', 'aria-hidden': true, children: '·' }),
        jsx('span', {
          className: pct != null && pct >= 70 ? 'dsm-ctx-hot' : undefined,
          children: pctLabel == null ? '—' : pctLabel + '%'
        }),
        jsx('span', { className: 'dsm-sep', 'aria-hidden': true, children: '·' }),
        jsx('span', { children: formatTokens(today?.total) })
      ]
    }),
    open
      ? jsx('div', { className: 'dsm-pop', role: 'dialog', 'aria-label': t('title'), children: jsx(Panel, {
        data,
        error: query.error,
        fetchedAt: data?.generated_at,
        sessionUsage: sessionUsage && Number(sessionUsage.total) > 0 ? sessionUsage : null
      }) })
      : null
  ] })
}

export default {
  id: ID,
  name: 'DeepSeek Meter',
  description: 'Live DeepSeek balance, context load and token usage in the status bar.',
  register(ctx) {
    api = ctx
    ctx.i18n.register(LOCALES)

    const style = document.createElement('style')
    style.textContent = CSS
    document.head.append(style)
    ctx.onDispose(() => style.remove())

    ctx.register({
      id: 'meter',
      area: 'statusBar.right',
      order: 118,
      render: () => jsx(Meter, {})
    })
  }
}
