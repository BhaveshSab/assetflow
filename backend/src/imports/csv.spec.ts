import { parseAssetsCsv } from './csv';
describe('Strict asset CSV', () => {
  it('accepts BOM, escaped quotes, commas and CRLF', () => {
    const result = parseAssetsCsv(
      '\ufeffname,categoryId\r\n"A, ""B""",cat\r\n',
    );
    expect(result.rows[0].name).toBe('A, "B"');
    expect(result.errors).toEqual([]);
  });
  it.each([
    '',
    'name,categoryId\n',
    'name,categoryId\nA,B,C',
    'name,name,categoryId\nA,B,C',
  ])('rejects malformed input %s', (csv) =>
    expect(() => parseAssetsCsv(csv)).toThrow(),
  );
  it('bounds bytes, records and fields', () => {
    for (const csv of [
      'x'.repeat(60001),
      'name,categoryId\n' + 'A,B\n'.repeat(201),
      `name,categoryId\n${'A'.repeat(3000)},B`,
    ])
      expect(() => parseAssetsCsv(csv)).toThrow();
  });
  it('reports field-level errors and disallows formula prefixes', () => {
    const p = parseAssetsCsv(
      'name,categoryId,condition,isBookable\n=BAD,cat,UNREAL,yes',
    );
    expect(p.errors.map((e) => e.field)).toEqual([
      'name',
      'condition',
      'isBookable',
    ]);
  });
});
