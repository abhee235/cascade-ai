// lib/money.ts — ONE money formatter (round 11's rule: two decimals, everywhere, no exceptions).
export const fmtMoney = (n: number): string => `$${n.toFixed(2)}`
