import { validateProblemReportBody } from '../handlers/problemReportSubmit';

describe('validateProblemReportBody', () => {
  it('qabul: tushuntirish matni', () => {
    expect(validateProblemReportBody('Bot notogri film topdi, aslida boshqa serial edi').ok).toBe(true);
  });

  it('rad: juda qisqa', () => {
    const r = validateProblemReportBody('test');
    expect(r.ok).toBe(false);
  });

  it('rad: havola', () => {
    const r = validateProblemReportBody('https://www.instagram.com/reel/ABC/');
    expect(r.ok).toBe(false);
  });

  it('rad: buyruq', () => {
    expect(validateProblemReportBody('/cancel').ok).toBe(false);
  });

  it('rad: faqat raqam', () => {
    expect(validateProblemReportBody('1146').ok).toBe(false);
  });
});
