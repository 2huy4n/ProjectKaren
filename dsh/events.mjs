// 节日 / 生日推算。
//
// 公历节日是固定月日；农历节日用一张**按年**的公历日期表（2026-2035，见下表）。
// 之所以不用算法：农历编算牵扯闰月与「无中气」规则，2033 年正是历史争议年，
// 自算或引旧库极易给出错误日期（2033 中秋错成 10-07、重阳错成 10-31）。
// 本表逐格经双源核对，主源为香港天文台逐日公曆與農曆對照表。
//
// 注意：10-01 既可能是国庆、也可能同时是中秋(2031)或重阳(2033)，
// 所以「今天是哪个节日」一律返回**数组**。

/** 公历固定日期节日：'MM-DD' → 节日 id。 */
const SOLAR = {
  '01-01': 'newYear',
  '02-14': 'valentine',
  '03-08': 'womensDay',
  '04-01': 'aprilFools',
  '05-01': 'laborDay',
  '06-01': 'childrensDay',
  '09-10': 'teachersDay',
  '10-01': 'nationalDay',
  '10-31': 'halloween',
  '12-24': 'christmasEve',
  '12-25': 'christmas',
  '12-31': 'newYearEve',
}

/**
 * 农历节日 → 该年公历日期（'MM-DD'）。
 * 2026-2035。2033 取样按「闰十一月」口径（争议年，详见 README）。
 */
const LUNAR = {
  2026: { springFestival: '02-17', lantern: '03-03', dragonBoat: '06-19', qixi: '08-19', midAutumn: '09-25', doubleNinth: '10-18' },
  2027: { springFestival: '02-06', lantern: '02-20', dragonBoat: '06-09', qixi: '08-08', midAutumn: '09-15', doubleNinth: '10-08' },
  2028: { springFestival: '01-26', lantern: '02-09', dragonBoat: '05-28', qixi: '08-26', midAutumn: '10-03', doubleNinth: '10-26' },
  2029: { springFestival: '02-13', lantern: '02-27', dragonBoat: '06-16', qixi: '08-16', midAutumn: '09-22', doubleNinth: '10-16' },
  2030: { springFestival: '02-03', lantern: '02-17', dragonBoat: '06-05', qixi: '08-05', midAutumn: '09-12', doubleNinth: '10-05' },
  2031: { springFestival: '01-23', lantern: '02-06', dragonBoat: '06-24', qixi: '08-24', midAutumn: '10-01', doubleNinth: '10-24' },
  2032: { springFestival: '02-11', lantern: '02-25', dragonBoat: '06-12', qixi: '08-12', midAutumn: '09-19', doubleNinth: '10-12' },
  2033: { springFestival: '01-31', lantern: '02-14', dragonBoat: '06-01', qixi: '08-01', midAutumn: '09-08', doubleNinth: '10-01' },
  2034: { springFestival: '02-19', lantern: '03-05', dragonBoat: '06-20', qixi: '08-20', midAutumn: '09-27', doubleNinth: '10-20' },
  2035: { springFestival: '02-08', lantern: '02-22', dragonBoat: '06-10', qixi: '08-10', midAutumn: '09-16', doubleNinth: '10-09' },
}

/** 农历表覆盖的年份；超出范围的年份只认公历节日。 */
export const LUNAR_YEARS = Object.keys(LUNAR).map(Number)
export const LUNAR_MIN_YEAR = Math.min(...LUNAR_YEARS)
export const LUNAR_MAX_YEAR = Math.max(...LUNAR_YEARS)

const pad = (n) => String(n).padStart(2, '0')
const mmdd = (d) => pad(d.getMonth() + 1) + '-' + pad(d.getDate())

/** 该年是否在农历表覆盖范围内。 */
export function lunarYearCovered(year) {
  return Object.prototype.hasOwnProperty.call(LUNAR, year)
}

/**
 * 今天有哪些节日——可能多个（例：2031-10-01 = 国庆 + 中秋）。
 * @returns {Array<{id: string, lunar: boolean}>}
 */
export function holidaysOn(ms) {
  const at = new Date(ms)
  const key = mmdd(at)
  const found = []
  if (SOLAR[key]) found.push({ id: SOLAR[key], lunar: false })
  const table = LUNAR[at.getFullYear()]
  if (table) {
    for (const [id, date] of Object.entries(table)) {
      if (date === key) found.push({ id, lunar: true })
    }
  }
  return found
}

/** 各月天数；2 月按 29 算——02-29 是合法的生日，只是平年不触发。 */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/** 'MM-DD' 解析；日期不存在（如 02-30、13-01）返回 null。 */
export function parseMonthDay(value) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(value == null ? '' : value).trim())
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12) return null
  if (day < 1 || day > DAYS_IN_MONTH[month - 1]) return null
  return { month, day, key: pad(month) + '-' + pad(day) }
}

/** 生日字段归一化成 'MM-DD' 或 ''。 */
export function normalizeBirthday(value) {
  const parsed = parseMonthDay(value)
  return parsed ? parsed.key : ''
}

/**
 * 今天是「谁的生日」。
 * @returns {'self'|'user'|'both'|null} self = 角色生日
 */
export function birthdayKind(ms, cfg) {
  const today = mmdd(new Date(ms))
  const self = normalizeBirthday(cfg && cfg.birthdaySelf)
  const user = normalizeBirthday(cfg && cfg.birthdayUser)
  const isSelf = !!self && self === today
  const isUser = !!user && user === today
  if (isSelf && isUser) return 'both'
  if (isSelf) return 'self'
  if (isUser) return 'user'
  return null
}
