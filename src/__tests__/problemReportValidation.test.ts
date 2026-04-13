import { validateProblemReportBody } from '../handlers/problemReportSubmit';

describe('validateProblemReportBody', () => {
  it('qabul: tushuntirish matni', () => {
    expect(validateProblemReportBody('Bot notogri film topdi, aslida boshqa serial edi', 'uz').ok).toBe(
      true
    );
  });

  it('rad: juda qisqa', () => {
    const r = validateProblemReportBody('test', 'uz');
    expect(r.ok).toBe(false);
  });

  it('rad: havola', () => {
    const r = validateProblemReportBody('https://www.instagram.com/reel/ABC/', 'uz');
    expect(r.ok).toBe(false);
  });

  it('rad: buyruq', () => {
    expect(validateProblemReportBody('/cancel', 'uz').ok).toBe(false);
  });

  it('rad: faqat raqam', () => {
    expect(validateProblemReportBody('1146', 'uz').ok).toBe(false);
  });
});
