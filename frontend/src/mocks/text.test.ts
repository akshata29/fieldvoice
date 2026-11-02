import { describe, expect, it } from 'vitest';
import { Rng, hashString } from '@/mocks/rng';
import { digitsToSpokenText, digitsToWords, groupedIdWords, normalizeNumbers, numberToWords, spaceDigits, wordErrorRate } from '@/mocks/text';

describe('number words', () => {
  it('renders digits, numbers and grouped ids', () => {
    expect(digitsToWords('305')).toBe('three zero five');
    expect(numberToWords(25)).toBe('twenty five');
    expect(numberToWords(100)).toBe('one hundred');
    expect(numberToWords(482)).toBe('four hundred eighty two');
    expect(groupedIdWords('123')).toBe('one twenty three');
    expect(groupedIdWords('211')).toBe('two eleven');
    expect(groupedIdWords('305')).toBe('three hundred five');
    expect(groupedIdWords('300')).toBe('three hundred');
    expect(groupedIdWords('88201')).toBe('eight eight two zero one');
  });
});

describe('normalizeNumbers', () => {
  it.each([
    ['pole one two three', 'pole 123'],
    ['pole one twenty three', 'pole 123'],
    ['unit two eleven', 'unit 211'],
    ['unit three hundred five', 'unit 305'],
    ['one hundred twenty three', '123'],
    ['twenty five kva transformer', '25 kva transformer'],
    ['seventy-five kva', '75 kva'],
    ['reading four hundred eighty two kilowatt hours', 'reading 482 kilowatt hours'],
    ['meter eight eight two zero one', 'meter 88201'],
    ['angle thirty degrees', 'angle 30 degrees'],
    ['pole 123 and unit 456', 'pole 123 and unit 456'],
    ['pole 1 2 3, 2 5 kva', 'pole 123, 25 kva'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeNumbers(input)).toBe(expected);
  });

  it('keeps sentence punctuation and does not turn a lone "one" into a number', () => {
    expect(normalizeNumbers('The old one was leaking. I installed unit four five six.')).toBe('The old one was leaking. I installed unit 456.');
    expect(normalizeNumbers('pole one, then unit two')).toBe('pole 1, then unit 2');
  });

  it('is case-insensitive and leaves unrelated words alone', () => {
    expect(normalizeNumbers('Pole Three Two One often')).toBe('Pole 321 often');
  });

  it('round-trips the spoken renderings used by the mock engines', () => {
    for (const id of ['123', '211', '305', '456', '518', '734', '845']) {
      expect(normalizeNumbers(`pole ${digitsToWords(id)}`)).toBe(`pole ${id}`);
      expect(normalizeNumbers(`pole ${groupedIdWords(id)}`)).toBe(`pole ${id}`);
    }
    expect(normalizeNumbers(digitsToSpokenText('unit 456 and meter 88201'))).toBe('unit 456 and meter 88201');
    expect(normalizeNumbers(spaceDigits('pole 123 and unit 456, 25 kva'))).toBe('pole 123 and unit 456, 25 kva');
  });
});

describe('spaceDigits', () => {
  it('spaces multi-digit numbers like a small Whisper model', () => {
    expect(spaceDigits('pole 123, 25 kva, 7 poles')).toBe('pole 1 2 3, 2 5 kva, 7 poles');
  });
});

describe('wordErrorRate', () => {
  it('is 0 for identical text (ignoring case/punctuation) and 1 for nothing recognised', () => {
    expect(wordErrorRate('Replaced the transformer.', 'replaced the transformer')).toBe(0);
    expect(wordErrorRate('replaced the transformer', '')).toBe(1);
    expect(wordErrorRate('', '')).toBe(0);
  });

  it('counts substitutions, insertions and deletions', () => {
    expect(wordErrorRate('a b c d', 'a x c d')).toBe(0.25);
    expect(wordErrorRate('a b c d', 'a b c d e')).toBe(0.25);
    expect(wordErrorRate('a b c d', 'a b d')).toBe(0.25);
  });

  it('shows why raw WER misleads on numbers while normalised WER does not', () => {
    const spoken = 'pole one two three';
    const hyp = 'pole 123';
    expect(wordErrorRate(spoken, hyp)).toBeGreaterThan(0.5);
    expect(wordErrorRate(normalizeNumbers(spoken), normalizeNumbers(hyp))).toBe(0);
  });
});

describe('Rng', () => {
  it('is deterministic per seed and covers its ranges', () => {
    const a = new Rng('seed-1');
    const b = new Rng('seed-1');
    expect(Array.from({ length: 5 }, () => a.float())).toEqual(Array.from({ length: 5 }, () => b.float()));
    expect(hashString('x')).toBe(hashString('x'));
    expect(hashString('x')).not.toBe(hashString('y'));
    const r = new Rng(42);
    for (let i = 0; i < 200; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
    expect(new Rng(1).shuffle([1, 2, 3, 4]).sort()).toEqual([1, 2, 3, 4]);
  });
});
