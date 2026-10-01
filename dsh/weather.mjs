// 城市天气：Open-Meteo（免 API Key、无需注册）。
//
// 两步：geocoding 把城市名换成经纬度 → forecast 取当前+今日的天气。
// 只依赖全局 fetch（Node 22+）。失败一律 throw，由调用方决定降级与缓存。
const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const TIMEOUT_MS = 15000

/**
 * WMO weather code 归成一组稳定的 i18n 键后缀。
 * 不逐码翻译（95/96/99 都是雷暴），减少词典条数与漏译风险。
 */
export function weatherKey(code) {
  const c = Number(code)
  if (!Number.isFinite(c)) return 'unknown'
  if (c === 0) return 'clear'
  if (c === 1 || c === 2) return 'partly'
  if (c === 3) return 'overcast'
  if (c === 45 || c === 48) return 'fog'
  if (c >= 51 && c <= 57) return 'drizzle'
  if (c >= 61 && c <= 67) return 'rain'
  if (c >= 71 && c <= 77) return 'snow'
  if (c >= 80 && c <= 82) return 'showers'
  if (c === 85 || c === 86) return 'snowShowers'
  if (c >= 95) return 'thunder'
  return 'unknown'
}

/** 下雨/下雪这类需要带伞的天气——用来给问候语加一句提醒。 */
export function isWet(code) {
  const key = weatherKey(code)
  return key === 'drizzle' || key === 'rain' || key === 'showers' || key === 'thunder' || key === 'snow' || key === 'snowShowers'
}

async function getJson(url, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onAbort = () => controller.abort()
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'project-karen' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 城市名 → { name, country, latitude, longitude }；找不到返回 null。 */
export async function geocode(city, lang, signal) {
  const name = String(city == null ? '' : city).trim()
  if (!name) return null
  const url = GEO_URL + '?name=' + encodeURIComponent(name) +
    '&count=1&format=json&language=' + (lang === 'zh' ? 'zh' : 'en')
  const data = await getJson(url, signal)
  const hit = data && Array.isArray(data.results) ? data.results[0] : null
  if (!hit) return null
  return {
    name: String(hit.name || name),
    country: String(hit.country || ''),
    latitude: Number(hit.latitude),
    longitude: Number(hit.longitude),
  }
}

/**
 * 取当前天气 + 今日高低温和天气码。
 * @returns {{place,country,tempC,code,isDay,tMaxC,tMinC,timeZone,fetchedAt}}
 */
export async function fetchWeather(city, lang, signal) {
  const place = await geocode(city, lang, signal)
  if (!place) return null
  const url = FORECAST_URL +
    '?latitude=' + place.latitude + '&longitude=' + place.longitude +
    '&current=temperature_2m,weather_code,is_day' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code' +
    '&timezone=auto&forecast_days=1'
  const data = await getJson(url, signal)
  const cur = (data && data.current) || {}
  const day = (data && data.daily) || {}
  const first = (list) => (Array.isArray(list) && list.length > 0 ? list[0] : null)
  const code = Number(cur.weather_code)
  return {
    place: place.name,
    country: place.country,
    tempC: Number.isFinite(Number(cur.temperature_2m)) ? Math.round(Number(cur.temperature_2m)) : null,
    code: Number.isFinite(code) ? code : null,
    isDay: cur.is_day === 1,
    tMaxC: Number.isFinite(Number(first(day.temperature_2m_max))) ? Math.round(Number(first(day.temperature_2m_max))) : null,
    tMinC: Number.isFinite(Number(first(day.temperature_2m_min))) ? Math.round(Number(first(day.temperature_2m_min))) : null,
    timeZone: String(data?.timezone || ''),
    fetchedAt: Date.now(),
  }
}
