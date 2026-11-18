/**
 * DeepSeek meter — statusbar chips for the live API balance and today's
 * token/cost usage.
 *
 * Data comes from this plugin's own Python backend (`plugins/deepseek-meter/
 * dashboard/plugin_api.py` → `/api/plugins/deepseek-meter/stats`), so the API
 * key never touches the renderer.
 */

import { useQuery, useValue, host } from '@hermes/plugin-sdk'
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
    return new Date(Number(seconds) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return '—'
  }
}

function pickBalance(balance) {
  const infos = Array.isArray(balance?.infos) ? balance.infos : []
  if (!infos.length) return null
  return infos.find(info => Number(info.total) > 0) || infos[0]
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

function Labelled({ label, value, strong }) {
  return jsxs('div', { className: 'dsm-row', children: [
    jsx('span', { className: 'dsm-row-label', children: label }),
    jsx('span', { className: strong ? 'dsm-row-value dsm-strong' : 'dsm-row-value', children: value })
  ] })
}

function Panel({ data, error, fetchedAt, sessionUsage }) {
  const balance = data?.balance
  const usage = data?.usage
  const info = pickBalance(balance)
  const today = usage?.today
  const week = usage?.last_7d
  const all = usage?.all_time
  const contextPct = sessionUsage?.context_percent
  const contextUsed = Number(sessionUsage?.context_used || 0)
  const contextMax = Number(sessionUsage?.context_max || 0)
  const rows = []

  if (info) {
    rows.push(jsx(Labelled, { label: 'Баланс', value: formatMoney(info.total, info.currency), strong: true }))
    rows.push(jsx(Labelled, { label: 'Пополнено', value: formatMoney(info.topped_up, info.currency) }))
    rows.push(jsx(Labelled, { label: 'Грант', value: formatMoney(info.granted, info.currency) }))
  } else {
    rows.push(jsx(Labelled, { label: 'Баланс', value: '—', strong: true }))
  }
  rows.push(jsx(Labelled, { label: 'Обновлено', value: formatClock(fetchedAt || balance?.fetched_at) }))
  if (balance?.is_available === false) {
    rows.push(jsx(Labelled, { label: 'Аккаунт', value: 'недоступен' }))
  }

  // ── context window ───────────────────────────────────────────────
  const pct = (() => {
    const percent = contextPct
    if (percent != null && Number.isFinite(Number(percent))) return Math.max(0, Math.min(100, Number(percent)))
    if (contextUsed > 0 && contextMax > 0) return Math.max(0, Math.min(100, (contextUsed / contextMax) * 100))
    return null
  })()
  const contextTone = pct == null ? 'ok' : pct >= 90 ? 'down' : pct >= 70 ? 'stale' : 'ok'
  rows.push(jsxs('div', { className: 'dsm-group', children: [
    jsxs('div', { className: 'dsm-row', children: [
      jsx('span', { className: 'dsm-row-label', children: 'Контекст' }),
      jsx('span', { className: 'dsm-row-value dsm-strong', children: pct == null ? '—' : Math.round(pct) + '%' })
    ] }),
    pct == null
      ? null
      : jsx('div', { className: 'dsm-track', 'data-tone': contextTone, children: jsx('span', {
        className: 'dsm-fill',
        style: { width: Math.max(2, pct) + '%' }
      }) }),
    contextMax
      ? jsx('div', { className: 'dsm-caption-inline', children: formatTokens(contextUsed) + ' / ' + formatTokens(contextMax) + ' токенов' })
      : null
  ] }))


  if (today) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, { label: 'Сегодня', value: formatTokens(today.total) + ' токенов', strong: true }),
      jsx(Labelled, { label: 'Вход / выход', value: formatTokens(today.input) + ' / ' + formatTokens(today.output) }),
      today.cached ? jsx(Labelled, { label: 'Из кэша', value: formatTokens(today.cached) }) : null,
      jsx(Labelled, { label: 'Стоимость', value: '~$' + Number(today.cost_usd || 0).toFixed(4) }),
      jsx(Labelled, { label: 'Запросов', value: String(today.calls || 0) + ' · ' + String(today.sessions || 0) + ' сесс.' })
    ] }))
  }

  if (week || all) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, { label: '7 дней', value: week ? formatTokens(week.total) + ' · ~$' + Number(week.cost_usd || 0).toFixed(3) : '—' }),
      jsx(Labelled, { label: 'Всего', value: all ? formatTokens(all.total) + ' · ~$' + Number(all.cost_usd || 0).toFixed(3) : '—' })
    ] }))
  }

  if (sessionUsage) {
    rows.push(jsxs('div', { className: 'dsm-group', children: [
      jsx(Labelled, { label: 'Эта сессия', value: formatTokens(sessionUsage.total) + ' токенов', strong: true }),
      jsx(Labelled, { label: 'Вход / выход', value: formatTokens(sessionUsage.input) + ' / ' + formatTokens(sessionUsage.output) }),
      sessionUsage.cost_usd ? jsx(Labelled, { label: 'Стоимость', value: '~$' + Number(sessionUsage.cost_usd).toFixed(4) }) : null
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
  if (balance?.ok === false) rows.push(jsx('div', { className: 'dsm-error', children: 'Баланс: ' + String(balance.error || 'ошибка') }))
  if (usage?.ok === false) rows.push(jsx('div', { className: 'dsm-error', children: 'Статистика: ' + String(usage.error || 'ошибка') }))
  rows.push(jsx('div', { className: 'dsm-caption', children: 'авто-сжатие при 50% · обновление 20 с' }))

  return jsxs('div', { className: 'dsm-body', children: [
    jsxs('div', { className: 'dsm-head', children: [
      jsx('span', { className: 'dsm-title', children: 'DeepSeek' }),
      jsx('span', { className: 'dsm-updated', children: balance?.stale ? 'кэш' : balance?.ok === false ? 'нет данных' : 'live' })
    ] }),
    rows
  ] })
}

function Meter() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const query = useStats()
  const sessionUsage = useValue(host.state.focusedUsage)
  const data = query.data
  const info = pickBalance(data?.balance)
  const today = data?.usage?.today
  const tone = toneFor(data?.balance, data?.usage, query.error)
  const contextPct = (() => {
    const percent = sessionUsage?.context_percent
    if (percent != null && Number.isFinite(Number(percent))) return Math.max(0, Math.min(100, Number(percent)))
    const used = Number(sessionUsage?.context_used || 0)
    const max = Number(sessionUsage?.context_max || 0)
    if (used > 0 && max > 0) return Math.max(0, Math.min(100, (used / max) * 100))
    return null
  })()
  const tip = query.error
    ? 'DeepSeek meter: ' + String(query.error.message || query.error)
    : info
      ? 'DeepSeek: ' + formatMoney(info.total, info.currency)
        + ' · сегодня ' + formatTokens(today?.total) + ' токенов'
        + (contextPct != null ? ' · контекст ' + Math.round(contextPct) + '%' : '')
      : 'DeepSeek: загрузка…'

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
          className: contextPct != null && contextPct >= 70 ? 'dsm-ctx-hot' : undefined,
          children: contextPct != null ? Math.round(contextPct) + '%' : '—'
        }),
        jsx('span', { className: 'dsm-sep', 'aria-hidden': true, children: '·' }),
        jsx('span', { children: formatTokens(today?.total) })
      ]
    }),
    open
      ? jsx('div', { className: 'dsm-pop', role: 'dialog', 'aria-label': 'DeepSeek', children: jsx(Panel, {
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
  description: 'Live DeepSeek balance and token usage in the status bar.',
  register(ctx) {
    api = ctx
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
