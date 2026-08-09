/*
 * Countries and their currencies — the single source of truth for both sides.
 *
 * The frontend renders the dropdown from `GET /reference/countries` rather than
 * carrying its own copy, so the two lists cannot drift. More importantly, the
 * CURRENCY IS NEVER ACCEPTED FROM THE CLIENT: it is looked up here from the
 * country code on every write. A form can suggest "India → INR"; only this
 * table decides it. Otherwise a crafted request could pair a country with
 * whatever currency it liked, and every figure reported against that branch
 * would be silently wrong.
 *
 * `code` is ISO 3166-1 alpha-2, `currency` is ISO 4217.
 */

export type Country = {
  code: string;
  name: string;
  currency: string;
  currencyName: string;
  symbol: string;
};

export const COUNTRIES: readonly Country[] = [
  { code: "AE", name: "United Arab Emirates", currency: "AED", currencyName: "UAE Dirham", symbol: "د.إ" },
  { code: "AR", name: "Argentina", currency: "ARS", currencyName: "Argentine Peso", symbol: "$" },
  { code: "AT", name: "Austria", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "AU", name: "Australia", currency: "AUD", currencyName: "Australian Dollar", symbol: "A$" },
  { code: "BD", name: "Bangladesh", currency: "BDT", currencyName: "Taka", symbol: "৳" },
  { code: "BE", name: "Belgium", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "BH", name: "Bahrain", currency: "BHD", currencyName: "Bahraini Dinar", symbol: ".د.ب" },
  { code: "BR", name: "Brazil", currency: "BRL", currencyName: "Brazilian Real", symbol: "R$" },
  { code: "CA", name: "Canada", currency: "CAD", currencyName: "Canadian Dollar", symbol: "C$" },
  { code: "CH", name: "Switzerland", currency: "CHF", currencyName: "Swiss Franc", symbol: "CHF" },
  { code: "CL", name: "Chile", currency: "CLP", currencyName: "Chilean Peso", symbol: "$" },
  { code: "CN", name: "China", currency: "CNY", currencyName: "Renminbi", symbol: "¥" },
  { code: "CO", name: "Colombia", currency: "COP", currencyName: "Colombian Peso", symbol: "$" },
  { code: "CZ", name: "Czechia", currency: "CZK", currencyName: "Czech Koruna", symbol: "Kč" },
  { code: "DE", name: "Germany", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "DK", name: "Denmark", currency: "DKK", currencyName: "Danish Krone", symbol: "kr" },
  { code: "EG", name: "Egypt", currency: "EGP", currencyName: "Egyptian Pound", symbol: "E£" },
  { code: "ES", name: "Spain", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "FI", name: "Finland", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "FR", name: "France", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "GB", name: "United Kingdom", currency: "GBP", currencyName: "Pound Sterling", symbol: "£" },
  { code: "GR", name: "Greece", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "HK", name: "Hong Kong", currency: "HKD", currencyName: "Hong Kong Dollar", symbol: "HK$" },
  { code: "HU", name: "Hungary", currency: "HUF", currencyName: "Forint", symbol: "Ft" },
  { code: "ID", name: "Indonesia", currency: "IDR", currencyName: "Rupiah", symbol: "Rp" },
  { code: "IE", name: "Ireland", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "IL", name: "Israel", currency: "ILS", currencyName: "New Shekel", symbol: "₪" },
  { code: "IN", name: "India", currency: "INR", currencyName: "Indian Rupee", symbol: "₹" },
  { code: "IT", name: "Italy", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "JP", name: "Japan", currency: "JPY", currencyName: "Yen", symbol: "¥" },
  { code: "KE", name: "Kenya", currency: "KES", currencyName: "Kenyan Shilling", symbol: "KSh" },
  { code: "KR", name: "South Korea", currency: "KRW", currencyName: "Won", symbol: "₩" },
  { code: "KW", name: "Kuwait", currency: "KWD", currencyName: "Kuwaiti Dinar", symbol: "د.ك" },
  { code: "LK", name: "Sri Lanka", currency: "LKR", currencyName: "Sri Lankan Rupee", symbol: "Rs" },
  { code: "MA", name: "Morocco", currency: "MAD", currencyName: "Moroccan Dirham", symbol: "د.م." },
  { code: "MX", name: "Mexico", currency: "MXN", currencyName: "Mexican Peso", symbol: "$" },
  { code: "MY", name: "Malaysia", currency: "MYR", currencyName: "Malaysian Ringgit", symbol: "RM" },
  { code: "NG", name: "Nigeria", currency: "NGN", currencyName: "Naira", symbol: "₦" },
  { code: "NL", name: "Netherlands", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "NO", name: "Norway", currency: "NOK", currencyName: "Norwegian Krone", symbol: "kr" },
  { code: "NZ", name: "New Zealand", currency: "NZD", currencyName: "New Zealand Dollar", symbol: "NZ$" },
  { code: "OM", name: "Oman", currency: "OMR", currencyName: "Rial Omani", symbol: "ر.ع." },
  { code: "PH", name: "Philippines", currency: "PHP", currencyName: "Philippine Peso", symbol: "₱" },
  { code: "PK", name: "Pakistan", currency: "PKR", currencyName: "Pakistan Rupee", symbol: "Rs" },
  { code: "PL", name: "Poland", currency: "PLN", currencyName: "Zloty", symbol: "zł" },
  { code: "PT", name: "Portugal", currency: "EUR", currencyName: "Euro", symbol: "€" },
  { code: "QA", name: "Qatar", currency: "QAR", currencyName: "Qatari Riyal", symbol: "ر.ق" },
  { code: "RO", name: "Romania", currency: "RON", currencyName: "Romanian Leu", symbol: "lei" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", currencyName: "Saudi Riyal", symbol: "ر.س" },
  { code: "SE", name: "Sweden", currency: "SEK", currencyName: "Swedish Krona", symbol: "kr" },
  { code: "SG", name: "Singapore", currency: "SGD", currencyName: "Singapore Dollar", symbol: "S$" },
  { code: "TH", name: "Thailand", currency: "THB", currencyName: "Baht", symbol: "฿" },
  { code: "TR", name: "Türkiye", currency: "TRY", currencyName: "Turkish Lira", symbol: "₺" },
  { code: "TW", name: "Taiwan", currency: "TWD", currencyName: "New Taiwan Dollar", symbol: "NT$" },
  { code: "TZ", name: "Tanzania", currency: "TZS", currencyName: "Tanzanian Shilling", symbol: "TSh" },
  { code: "UA", name: "Ukraine", currency: "UAH", currencyName: "Hryvnia", symbol: "₴" },
  { code: "US", name: "United States", currency: "USD", currencyName: "US Dollar", symbol: "$" },
  { code: "VN", name: "Vietnam", currency: "VND", currencyName: "Dong", symbol: "₫" },
  { code: "ZA", name: "South Africa", currency: "ZAR", currencyName: "Rand", symbol: "R" },
];

const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/** The codes zod validates against — an allowlist, not a format check. */
export const COUNTRY_CODES = COUNTRIES.map((c) => c.code) as [string, ...string[]];

export function getCountry(code: string | null | undefined): Country | undefined {
  return code ? BY_CODE.get(code.toUpperCase()) : undefined;
}

/**
 * The currency for a country. The ONE place a currency is decided.
 *
 * Returns null for an unknown code rather than guessing — a branch with no
 * country simply has no currency, which the UI shows as "—" instead of
 * inventing dollars.
 */
export function currencyFor(code: string | null | undefined): string | null {
  return getCountry(code)?.currency ?? null;
}
