import re

UNDETERMINED = "und"
_LOCALE_RE = re.compile(r"^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$")


def pick_name(names: dict, locale: str | None = "en-US") -> str:
    """Name for a locale: exact, same language, neutral, English, then whatever exists."""
    wanted = normalize_locale(locale)
    lang = wanted.split("-")[0]
    for key in (wanted, *[k for k in names if k.split("-")[0] == lang], UNDETERMINED, *[k for k in names if k.split("-")[0] == "en"]):
        if names.get(key):
            return names[key]
    return next(iter(names.values()), "")


def normalize_names(raw) -> dict:
    """Clean a {locale: text} map: normalized locales, trimmed, no empty texts."""
    result = {}
    if isinstance(raw, dict):
        for locale, text in raw.items():
            text = str(text or "").strip()
            if text:
                result[normalize_locale(str(locale))] = text
    return result


def normalize_locale(locale: str | None) -> str:
    """BCP 47 casing ("ja_jp" -> "ja-JP"); missing or invalid input means the neutral "und" bucket."""
    text = (locale or "").strip()
    if not text or text.lower() == UNDETERMINED or not _LOCALE_RE.match(text):
        return UNDETERMINED
    first, *rest = re.split(r"[-_]", text)
    parts = [first.lower()]
    for part in rest:
        if len(part) == 2 and part.isalpha():
            parts.append(part.upper())
        elif len(part) == 4 and part.isalpha():
            parts.append(part.title())
        else:
            parts.append(part)
    return "-".join(parts)
