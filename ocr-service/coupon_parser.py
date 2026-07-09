import re
from typing import Iterable


KEYWORDS = (
    "\u5238\u7801",
    "\u6838\u9500\u7801",
    "\u4f18\u60e0\u7801",
    "\u5151\u6362\u7801",
    "\u9a8c\u8bc1\u7801",
    "\u7f16\u7801",
    "\u7801",
    "CODE",
    "Code",
    "code",
)


def normalize_text(value: str) -> str:
    return (
        str(value or "")
        .replace("\uff1a", ":")
        .replace("\uff0d", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .strip()
    )


def normalize_code(value: str) -> str:
    text = re.sub(r"[\s\-_:：]", "", str(value or ""))
    return text.replace("O", "0").replace("o", "0").upper()


def unique(values: Iterable[str]) -> list[str]:
    seen = set()
    result = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def parse_coupon_code(texts: list[str]) -> dict:
    normalized_texts = [normalize_text(item) for item in texts if normalize_text(item)]
    raw_text = "\n".join(normalized_texts)
    candidates = []

    keyword_regex = re.compile(
        r"(?:"
        + "|".join(re.escape(keyword) for keyword in KEYWORDS)
        + r")\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\s\-_:：]{5,40})"
    )

    for match in keyword_regex.finditer(raw_text):
        code = normalize_code(match.group(1))
        if re.fullmatch(r"[A-Z0-9]{8,32}", code):
            candidates.append(code)

    for text in normalized_texts:
        compact = normalize_code(text)
        for code in re.findall(r"[A-Z0-9]{8,32}", compact):
            if not code.isdigit():
                candidates.append(code)

    unique_candidates = unique(candidates)
    return {
        "couponCode": unique_candidates[0] if unique_candidates else "",
        "candidates": unique_candidates,
        "rawText": raw_text,
    }
