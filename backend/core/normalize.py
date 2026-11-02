"""Transcript normalization: spoken numbers -> digits, spaced digits -> ids, NATO letters, fillers, units.

ASR engines write the same utterance differently ("pole 123", "pole 1 2 3", "pole one two three"). Everything
downstream (closed-world id resolution, enum matching, LLM prompts) works on the *normalized* text produced here.
The normalizer is deterministic, dependency-free and fast (microseconds), so it costs nothing in the latency budget.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from backend.schemas.extraction import Evidence

UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "niner": 9,
}
TEENS = {
    "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
SCALES = {"hundred": 100, "thousand": 1000}
NUMBER_WORDS = set(UNITS) | set(TEENS) | set(TENS) | set(SCALES)

NATO = {
    "alpha": "A", "alfa": "A", "bravo": "B", "charlie": "C", "delta": "D", "echo": "E", "foxtrot": "F", "golf": "G",
    "hotel": "H", "india": "I", "juliet": "J", "juliett": "J", "kilo": "K", "lima": "L", "mike": "M", "november": "N",
    "oscar": "O", "papa": "P", "quebec": "Q", "romeo": "R", "sierra": "S", "tango": "T", "uniform": "U", "victor": "V",
    "whiskey": "W", "xray": "X", "yankee": "Y", "zulu": "Z",
}
FILLERS = {"um", "uh", "er", "erm", "uhm", "hmm", "ah", "eh"}

# Words after which a bare number is (almost certainly) an identifier.
ID_TRIGGERS = {
    "pole", "poles", "unit", "units", "transformer", "meter", "feeder", "fuse", "switch", "circuit", "panel", "serial",
    "number", "no", "tag", "id", "cabinet", "pedestal", "pad", "structure", "asset", "light", "streetlight", "lamp",
    "cutout", "recloser", "breaker", "tap", "installed", "replacement", "new", "old", "removed", "at",
}
STRONG_ID_TRIGGERS = ID_TRIGGERS - {"at", "new", "old", "installed", "replacement", "removed", "no"}
QUANTITY_UNITS = {
    "kva", "kv", "kw", "volt", "volts", "v", "amp", "amps", "ampere", "amperes", "feet", "foot", "ft", "inch", "inches",
    "hour", "hours", "minute", "minutes", "percent", "degrees", "psi", "gallon", "gallons", "pound", "pounds", "lbs",
    "hz", "ohm", "ohms", "mile", "miles", "yard", "yards",
}
STOPWORDS = {
    "a", "an", "the", "and", "or", "but", "so", "to", "of", "in", "on", "at", "by", "for", "from", "with", "without",
    "it", "its", "this", "that", "these", "those", "there", "here", "i", "we", "you", "they", "he", "she", "my", "our",
    "their", "me", "us", "was", "were", "is", "are", "be", "been", "am", "did", "do", "does", "had", "have", "has",
    "then", "also", "just", "really", "very", "about", "around", "again", "as", "up", "down", "out", "off", "over",
    "into", "onto", "per", "all", "some", "any", "one", "both", "which", "who", "what", "when", "while", "after",
    "before", "if", "not", "no", "yes", "okay", "ok", "copy", "roger", "over", "dispatch", "sorry", "mean", "wait",
    "actually", "correction", "rather", "scratch", "make", "ll", "re", "ve", "s", "t", "d", "m",
}

_TOKEN_RE = re.compile(
    r"(?<![A-Za-z\d])(?:[A-Za-z]|[A-Z]{2})\d{1,6}(?![A-Za-z\d])"  # glued ids: A77, T4471, TX4471
    r"|[A-Za-z]+(?:'[A-Za-z]+)?|\d+(?:\.\d+)?|[^\sA-Za-z\d]")
_GLUED_ID = re.compile(r"(?:[A-Za-z]|[A-Z]{2})\d{1,6}")
# Whisper-medium writes spoken digit groups with hyphens ("pole 1-2-3", "feeder 23-22", "sorry, 3-28"): one number.
# A hyphen before a unit ("20-25 feet") is a range, and decimals / dates / fractions are left alone.
_HYPHENATED_DIGITS = re.compile(
    r"(?<!\d)(?<!\d[.\-/])(\d{1,3}(?:-\d{1,3})+)(?!\d|[.\-/]\d)(?!\s*(?:" + "|".join(sorted(QUANTITY_UNITS)) + r")\b)",
    re.I)
_SENT_END = {".", "!", "?", ";"}
# words after which a lone "one" is a pronoun ("the old one", "new one", "no one"), not the digit 1
PRONOUN_CONTEXT = {"at", "new", "old", "installed", "replacement", "removed", "no", "existing", "pulled", "put", "in",
                   "swapped", "out", "with", "and", "on", "the", "a", "this", "that", "other", "same", "next", "last"}


def stem(word: str) -> str:
    """Tiny suffix-stripping stemmer, good enough for matching "leaking"/"leaks"/"leaked" and "replace"/"replaced"."""
    w = word.lower().replace("'", "")
    if len(w) > 5 and w.endswith("ing"):
        w = w[:-3]
    elif len(w) > 4 and w.endswith("ied"):
        w = w[:-3] + "y"
    elif len(w) > 4 and w.endswith("ed"):
        w = w[:-2]
    elif len(w) > 4 and w.endswith("es"):
        w = w[:-2]
    elif len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        w = w[:-1]
    if len(w) > 3 and w.endswith("e"):
        w = w[:-1]
    if len(w) > 3 and w[-1] == w[-2] and w[-1] not in "aeiouls":
        w = w[:-1]
    return w


@dataclass(frozen=True)
class Token:
    text: str  # normalized surface
    start: int  # offset in the normalized text
    end: int
    kind: str  # "word" | "num" | "id" | "punct"
    stem: str = ""  # for words
    value: str | None = None  # canonical value for num / id tokens ("123", "A77", "14.2")

    @property
    def is_word(self) -> bool:
        return self.kind == "word"


@dataclass
class NormalizedText:
    raw: str
    text: str  # normalized transcript (lowercase words, digits, ids uppercase)
    clean: str  # raw transcript with fillers removed (for free-text fields)
    tokens: list[Token] = field(default_factory=list)

    def evidence(self, first: int, last: int) -> Evidence:
        """Evidence span covering tokens[first..last] inclusive."""
        a, b = self.tokens[first], self.tokens[last]
        return Evidence(start=a.start, end=b.end, text=self.text[a.start:b.end])

    def sentence_bounds(self, idx: int) -> tuple[int, int]:
        """Token index range [lo, hi] of the sentence containing token idx."""
        lo = idx
        while lo > 0 and not (self.tokens[lo - 1].kind == "punct" and self.tokens[lo - 1].text in _SENT_END):
            lo -= 1
        hi = idx
        while hi < len(self.tokens) - 1 and not (self.tokens[hi].kind == "punct" and self.tokens[hi].text in _SENT_END):
            hi += 1
        return lo, hi


@dataclass
class _Tok:
    text: str
    kind: str  # word | num | id | punct
    value: str | None = None


# ------------------------------------------------------------------------------------------------------------------
def _preprocess(raw: str) -> str:
    s = raw.replace("\u2019", "'").replace("\u2018", "'").replace("\u2013", "-").replace("\u2014", " - ")
    s = re.sub(r"(?<=\d),(?=\d{3}(?!\d))", "", s)  # 1,234 -> 1234
    s = _HYPHENATED_DIGITS.sub(lambda m: m.group(1).replace("-", ""), s)  # 1-2-3 -> 123
    s = re.sub(r"(?<=[A-Za-z])-(?=\d)", "", s)  # T-4471 -> T4471
    s = re.sub(r"(?<=[A-Za-z])-(?=[A-Za-z])", " ", s)  # twenty-five -> twenty five
    s = re.sub(r"\b([kK])\s*[- ]?\s*([vV])\s*[- ]?\s*([aA])\b", "kva", s)  # k v a -> kva
    s = re.sub(r"\b([kK])\s+([vV])\b", "kv", s)
    s = re.sub(r"\bkilo\s*volt\s*amp(?:ere)?s?\b", "kva", s, flags=re.I)
    return s


def _tokenize(raw: str) -> list[_Tok]:
    toks: list[_Tok] = []
    for m in _TOKEN_RE.finditer(_preprocess(raw)):
        t = m.group(0)
        if _GLUED_ID.fullmatch(t):
            toks.append(_Tok(t.upper(), "id", t.upper()))
        elif t[0].isdigit():
            toks.append(_Tok(t, "num", t))
        elif t[0].isalpha():
            toks.append(_Tok(t.lower(), "word"))
        else:
            toks.append(_Tok(t, "punct"))
    return toks


def _is_numword(t: _Tok) -> bool:
    return t.kind == "word" and t.text in NUMBER_WORDS


def _parse_cardinal(words: list[str]) -> int | None:
    total, cur, last = 0, 0, None
    for w in words:
        if w == "and":
            continue
        if w in UNITS:
            if last in ("unit", "teen"):
                return None
            cur += UNITS[w]
            last = "unit"
        elif w in TEENS:
            if last in ("unit", "teen", "tens"):
                return None
            cur += TEENS[w]
            last = "teen"
        elif w in TENS:
            if last in ("unit", "teen", "tens"):
                return None
            cur += TENS[w]
            last = "tens"
        elif w == "hundred":
            cur = max(cur, 1) * 100
            last = "hundred"
        elif w == "thousand":
            total += max(cur, 1) * 1000
            cur = 0
            last = "thousand"
        else:
            return None
    return total + cur


def _group_concat(words: list[str]) -> str:
    """"one twenty three" -> "123"; "twelve thirty four" -> "1234"; "four fifty six" -> "456"; "double five" -> "55"."""
    out: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        if w in ("double", "triple") and i + 1 < len(words) and (words[i + 1] in UNITS or words[i + 1] == "oh"):
            d = "0" if words[i + 1] == "oh" else str(UNITS[words[i + 1]])
            out.append(d * (2 if w == "double" else 3))
            i += 2
        elif w in TENS and i + 1 < len(words) and words[i + 1] in UNITS and UNITS[words[i + 1]] > 0:
            out.append(str(TENS[w] + UNITS[words[i + 1]]))
            i += 2
        elif w in TENS:
            out.append(str(TENS[w]))
            i += 1
        elif w in TEENS:
            out.append(str(TEENS[w]))
            i += 1
        elif w in UNITS:
            out.append(str(UNITS[w]))
            i += 1
        elif w == "oh":
            out.append("0")
            i += 1
        elif w.isdigit():
            out.append(w)
            i += 1
        else:
            i += 1
    return "".join(out)


def _convert_integer_words(words: list[str]) -> str:
    if any(w in SCALES for w in words):
        val = _parse_cardinal(words)
        if val is not None:
            return str(val)
    return _group_concat(words)


def _prev_word(toks: list[_Tok], i: int) -> str:
    return toks[i - 1].text if i > 0 and toks[i - 1].kind == "word" else ""


def _convert_numbers(toks: list[_Tok], id_triggers: set[str]) -> list[_Tok]:
    out: list[_Tok] = []
    i, n = 0, len(toks)
    while i < n:
        t = toks[i]
        starts_run = (
            _is_numword(t)
            or (t.kind == "word" and t.text in ("double", "triple") and i + 1 < n
                and (_is_numword(toks[i + 1]) or toks[i + 1].text == "oh"))
            or (t.kind == "word" and t.text == "oh" and i + 1 < n and (_is_numword(toks[i + 1]))
                and _prev_word(toks, i) in id_triggers)
            or t.kind == "num"
        )
        if not starts_run:
            out.append(t)
            i += 1
            continue

        # collect the run (digit tokens and number words are never mixed, except around "point")
        j = i
        run: list[_Tok] = []
        start_after_trigger = _prev_word(toks, i) in id_triggers
        mode: str | None = None
        while j < n:
            u = toks[j]
            if _is_numword(u) or u.kind == "num":
                m = "num" if u.kind == "num" else "word"
                if mode is None:
                    mode = m
                elif m != mode and not (run and run[-1].text in ("point", "dot")):
                    break
                run.append(u)
            elif u.kind == "word" and u.text in ("double", "triple") and j + 1 < n and (
                    _is_numword(toks[j + 1]) or toks[j + 1].text == "oh"):
                run.append(u)
            elif u.kind == "word" and u.text == "oh" and run and (run[-1].kind == "num" or run[-1].text in UNITS
                                                                  or run[-1].text in ("oh",)):
                run.append(u)
            elif u.kind == "word" and u.text == "oh" and not run and start_after_trigger \
                    and j + 1 < n and _is_numword(toks[j + 1]):
                run.append(u)
            elif u.kind == "word" and u.text == "and" and run and run[-1].text in ("hundred", "thousand") \
                    and j + 1 < n and _is_numword(toks[j + 1]):
                run.append(u)
            elif u.kind == "word" and u.text in ("point", "dot") and run and j + 1 < n and (
                    _is_numword(toks[j + 1]) or toks[j + 1].kind == "num"):
                run.append(u)
            else:
                break
            j += 1

        if j == i:  # no progress guard
            out.append(t)
            i += 1
            continue
        prev = _prev_word(toks, i)
        converted = _convert_run(run, prev in id_triggers, prev in PRONOUN_CONTEXT)
        if converted is None:
            out.extend(run)
        else:
            out.extend(converted)
        i = j
    return out


def _convert_run(run: list[_Tok], after_id_trigger: bool, pronoun_context: bool = False) -> list[_Tok] | None:
    words = [t.text for t in run]
    # decimals: "fourteen point two" / "14 point 2"
    for sep in ("point", "dot"):
        if sep in words:
            k = words.index(sep)
            left, right = run[:k], run[k + 1:]
            ltxt = _int_from(left, after_id_trigger)
            rtxt = "".join(_group_concat([r.text]) if r.kind == "word" else r.text for r in right)
            if ltxt and rtxt:
                v = f"{ltxt}.{rtxt}"
                return [_Tok(v, "num", v)]
            return None
    if len(run) == 1 and run[0].kind == "num":
        return None  # already a digit token; leave as is
    # all digit tokens (spaced digits): concatenate only for single digits or after an id trigger
    if all(t.kind == "num" for t in run):
        if len(run) >= 2 and (after_id_trigger or all(len(t.text) == 1 for t in run)):
            v = "".join(t.text for t in run)
            return [_Tok(v, "num", v)]
        return None
    # single number word: guard against idioms ("one of", "no one", "the old one")
    if len(run) == 1:
        w = run[0].text
        if w == "one" and (not after_id_trigger or pronoun_context):
            return None
        if w in SCALES:
            return None
    txt = _int_from(run, after_id_trigger)
    if not txt:
        return None
    return [_Tok(txt, "num", txt)]


def _int_from(run: list[_Tok], after_id_trigger: bool) -> str:
    # mixed digit tokens and number words: concatenate per token
    if any(t.kind == "num" for t in run):
        parts: list[str] = []
        buf: list[str] = []
        for t in run:
            if t.kind == "num":
                if buf:
                    parts.append(_convert_integer_words(buf))
                    buf = []
                parts.append(t.text)
            else:
                buf.append(t.text)
        if buf:
            parts.append(_convert_integer_words(buf))
        return "".join(parts)
    return _convert_integer_words([t.text for t in run])


def _build_ids(toks: list[_Tok], id_triggers: set[str]) -> list[_Tok]:
    """NATO words / spoken letters adjacent to digits -> alphanumeric id tokens ("tango four four seven one" -> T4471)."""
    out: list[_Tok] = []
    i, n = 0, len(toks)
    while i < n:
        t = toks[i]
        letter: str | None = None
        consumed = 1
        if t.kind == "word":
            # "a as in alpha"
            if i + 3 < n and len(t.text) == 1 and toks[i + 1].text == "as" and toks[i + 2].text == "in" \
                    and toks[i + 3].text in NATO:
                letter, consumed = NATO[toks[i + 3].text], 4
            elif t.text in NATO:
                nxt = toks[i + 1] if i + 1 < n else None
                prv = out[-1] if out else None
                adjacent_digit = (nxt is not None and nxt.kind == "num") or (prv is not None and prv.kind == "num")
                adjacent_nato = nxt is not None and nxt.kind == "word" and nxt.text in NATO
                after_trigger = prv is not None and prv.kind == "word" and prv.text in id_triggers
                if adjacent_digit or adjacent_nato or after_trigger:
                    letter = NATO[t.text]
            elif len(t.text) == 1 and t.text.isalpha() and t.text not in ("a", "i"):
                nxt = toks[i + 1] if i + 1 < n else None
                prv = out[-1] if out else None
                if nxt is not None and nxt.kind == "num" and prv is not None and prv.kind == "word" \
                        and prv.text in STRONG_ID_TRIGGERS:
                    letter = t.text.upper()
            elif t.text == "a":
                nxt = toks[i + 1] if i + 1 < n else None
                prv = out[-1] if out else None
                if nxt is not None and nxt.kind == "num" and len(nxt.text) >= 2 and prv is not None \
                        and prv.kind == "word" and prv.text in STRONG_ID_TRIGGERS:
                    letter = "A"
        if letter is None:
            out.append(t)
            i += 1
            continue
        # gather id: letters/NATO + digits (+ trailing letters)
        value = letter
        i += consumed
        while i < n:
            u = toks[i]
            if u.kind == "num" and "." not in u.text:
                value += u.text
                i += 1
            elif u.kind == "word" and u.text in NATO and i + 1 <= n:
                nxt2 = toks[i + 1] if i + 1 < n else None
                if (value[-1].isdigit() and (nxt2 is None or nxt2.kind != "word" or nxt2.text in NATO)) or \
                        not value[-1].isdigit():
                    value += NATO[u.text]
                    i += 1
                else:
                    break
            else:
                break
        out.append(_Tok(value, "id", value))
    return out


def normalize(raw: str, extra_id_triggers: set[str] | None = None) -> NormalizedText:
    """Normalize an ASR transcript. ``extra_id_triggers`` adds form-specific role words (e.g. "pole", "serial")."""
    id_triggers = ID_TRIGGERS | {t for t in (extra_id_triggers or set())}
    toks = _tokenize(raw)
    clean_toks: list[_Tok] = []
    skip_comma = False
    for t in toks:
        if t.kind == "word" and t.text in FILLERS:
            skip_comma = True
            continue
        if skip_comma and t.kind == "punct" and t.text == ",":
            skip_comma = False
            continue
        skip_comma = False
        if t.kind == "punct" and t.text == "," and clean_toks and clean_toks[-1].kind == "punct" \
                and clean_toks[-1].text == ",":
            continue
        clean_toks.append(t)
    while clean_toks and clean_toks[0].kind == "punct" and clean_toks[0].text in ",;:":
        clean_toks.pop(0)
    toks = _convert_numbers(clean_toks, id_triggers)
    toks = _build_ids(toks, id_triggers)

    parts: list[str] = []
    out_tokens: list[Token] = []
    pos = 0
    for t in toks:
        text = t.value if t.kind in ("num", "id") and t.value else t.text
        attach = t.kind == "punct" and text in ".,;:!?)%"
        if parts and not attach:
            parts.append(" ")
            pos += 1
        start = pos
        parts.append(text)
        pos += len(text)
        out_tokens.append(Token(
            text=text, start=start, end=pos, kind=t.kind,
            stem=stem(text) if t.kind == "word" else "",
            value=t.value if t.kind in ("num", "id") else None,
        ))
    text = "".join(parts)
    clean = re.sub(r"\s+", " ", re.sub(r"\b(?:um+|uh+|erm?|uhm|hmm+)\b[,.]?\s*", "", raw, flags=re.I)).strip()
    return NormalizedText(raw=raw, text=text, clean=clean, tokens=out_tokens)


def spoken_to_digits(spoken: str) -> str:
    """Convenience for tests and metrics: normalize and return only the text."""
    return normalize(spoken).text
