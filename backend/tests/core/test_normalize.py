"""Tests for the transcript normalizer."""
from __future__ import annotations

import pytest

from backend.core.normalize import normalize, stem


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("I replaced the transformer at pole 123.", "i replaced the transformer at pole 123."),
        ("I replaced the transformer at pole 1 2 3.", "i replaced the transformer at pole 123."),
        ("at pole one two three", "at pole 123"),
        ("pole one hundred twenty three", "pole 123"),
        ("pole one twenty three", "pole 123"),
        ("unit four fifty six", "unit 456"),
        ("unit twelve thirty four", "unit 1234"),
        ("pole oh seven", "pole 07"),
        ("pole one oh four", "pole 104"),
        ("serial double five seven", "serial 557"),
        ("serial triple zero", "serial 000"),
        ("pole two thousand five", "pole 2005"),
        ("meter one two three four five six seven eight", "meter 12345678"),
        ("a twenty five k v a transformer", "a 25 kva transformer"),
        ("rated fourteen point two kilovolts", "rated 14.2 kilovolts"),
        ("pole 12 3", "pole 123"),
    ],
)
def test_numbers(raw: str, expected: str) -> None:
    assert normalize(raw).text == expected


def test_idioms_keep_words() -> None:
    assert normalize("one of the poles was no one's").text == "one of the poles was no one's"
    assert normalize("it was the one on the left").text == "it was the one on the left"


def test_standalone_one_after_trigger() -> None:
    assert normalize("pole one").text == "pole 1"


def test_fillers_removed() -> None:
    n = normalize("Um, I installed, uh, unit 456.")
    assert n.text == "i installed, unit 456."
    assert "um" not in n.clean.lower().split()


def test_comma_separated_numbers_stay_separate() -> None:
    assert normalize("poles 1, 2, 3").text == "poles 1, 2, 3"


@pytest.mark.parametrize(
    "raw, expected",
    [
        # Whisper-medium writes spoken digit groups with hyphens; the other sizes write "1 2 3" or "123"
        ("I swapped the transformer at pole 1-2-3.", "i swapped the transformer at pole 123."),
        ("Power restored on feeder 23-22, 112 customers.", "power restored on feeder 2322, 112 customers."),
        ("installed unit 5-8-8", "installed unit 588"),
        ("at pole 1-900", "at pole 1900"),
        ("pole 1-2-3, sorry, 3-28.", "pole 123, sorry, 328."),
        ("pole Delta 4-4", "pole D44"),
        ("pole Bravo 1-2", "pole B12"),
    ],
)
def test_hyphenated_digit_groups_are_one_number(raw: str, expected: str) -> None:
    assert normalize(raw).text == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("a 30-35 feet pole", "a 30 - 35 feet pole"),  # a range before a unit
        ("2-3 hours", "2 - 3 hours"),
        ("a 40-foot pole", "a 40 - foot pole"),
        ("reading 14.2-15.1 kv", "reading 14.2 - 15.1 kv"),  # decimals
        ("date 2026-10-30", "date 2026 - 10 - 30"),  # a four-digit group is a year, not spoken digits
        ("pole 123 - installed unit 456", "pole 123 - installed unit 456"),  # a spaced dash is punctuation
    ],
)
def test_hyphens_that_are_not_digit_groups_stay(raw: str, expected: str) -> None:
    assert normalize(raw).text == expected


def test_nato_ids() -> None:
    assert normalize("transformer tango four four seven one").text == "transformer T4471"
    assert normalize("pole A as in alpha seven seven").text == "pole A77"
    assert normalize("pole T-4471").text == "pole T4471"


def test_nato_word_not_converted_in_names() -> None:
    assert normalize("mike checked the pole").text == "mike checked the pole"


def test_lone_one_after_role_words_is_a_pronoun() -> None:
    # regression: "old one 45863966" became "old 145863966" and "the new one is" became "the new 1 is"
    text = "old one 45863966 and the new one is 58834563"
    assert normalize(text).text == text
    assert normalize("the old one was leaking").text == "the old one was leaking"
    assert normalize("pole one").text == "pole 1"  # after a real noun trigger it is still the digit
    assert normalize("installed four five six").text == "installed 456"  # multi-word runs are numbers


def test_digit_tokens_and_number_words_do_not_merge() -> None:
    assert normalize("one 456").text == "one 456"
    assert normalize("pole 12 3").text == "pole 123"  # split digits still join


def test_glued_letter_ids_keep_together_without_a_trigger_word() -> None:
    n = normalize("pole 137, sorry, A77.")
    assert n.text == "pole 137, sorry, A77."
    assert [t.value for t in n.tokens if t.kind == "id"] == ["A77"]
    assert normalize("TX4471 and t-4471 and B12").text == "TX4471 and T4471 and B12"
    n2 = normalize("25kva")
    assert n2.text == "25 kva" and not [t for t in n2.tokens if t.kind == "id"]  # units are not ids


def test_tokens_offsets_are_consistent() -> None:
    n = normalize("I replaced the transformer at pole one two three.")
    for t in n.tokens:
        assert n.text[t.start:t.end] == t.text
    ev = n.evidence(0, 1)
    assert ev.text == "i replaced"


def test_stem_matching() -> None:
    assert stem("leaking") == stem("leaks") == stem("leaked") == stem("leak")
    assert stem("replaced") == stem("replace") == stem("replacing")


def test_sentence_bounds() -> None:
    n = normalize("First thing. Second thing here.")
    idx = next(i for i, t in enumerate(n.tokens) if t.text == "second")
    lo, hi = n.sentence_bounds(idx)
    assert n.tokens[lo].text == "second"
    assert n.tokens[hi].text == "."
