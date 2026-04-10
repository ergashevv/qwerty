describe('identifyMovie — consensus ham verifydan o‘tadi', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('faces va vision bir xil title berganda ham verify false bo‘lsa success qaytarmaydi', async () => {
    const axiosGet = jest.fn(async (url: string) => {
      if (url.includes('/search/person')) {
        return { data: { results: [{ id: 1 }] } };
      }
      if (url.includes('/person/1/combined_credits')) {
        return {
          data: {
            cast: [
              {
                id: 10,
                title: 'Iron Man',
                media_type: 'movie',
                vote_count: 1000,
                vote_average: 7.9,
                release_date: '2008-05-02',
              },
            ],
          },
        };
      }
      if (url.includes('/search/movie')) {
        return {
          data: {
            results: [
              {
                id: 10,
                title: 'Iron Man',
                media_type: 'movie',
                popularity: 100,
                release_date: '2008-05-02',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected axios url: ${url}`);
    });

    const azureChatVisionMock = jest
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Iron Man',
          type: 'movie',
          confidence: 'high',
          posterTitleReadable: false,
          billingName: '',
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          match: false,
          reason: 'same actor, wrong movie',
        })
      );

    jest.doMock('axios', () => ({
      __esModule: true,
      default: {
        get: axiosGet,
      },
    }));

    jest.doMock('../services/azureLlm', () => ({
      isAzureLlmConfigured: jest.fn(() => true),
      azureChatText: jest.fn(),
      azureChatVision: azureChatVisionMock,
    }));

    jest.doMock('../services/rekognition', () => ({
      recognizeCelebrities: jest.fn(async () => [{ name: 'Robert Downey Jr', confidence: 99 }]),
      extractImdbId: jest.fn(async () => null),
    }));

    const { identifyMovie } = await import('../services/movieService');
    const result = await identifyMovie(Buffer.from('frame').toString('base64'), 'image/jpeg');

    expect(azureChatVisionMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'llm_verify_failed') {
      expect(result.reason).toBe('llm_verify_failed');
      expect(result.candidates[0]?.title).toBe('Iron Man');
    }
  });

  test('verify false desa-yu alternativeTitle o‘sha title bo‘lsa ziddiyat deb qabul qiladi', async () => {
    const axiosGet = jest.fn(async (url: string) => {
      if (url.includes('/search/person')) {
        return { data: { results: [{ id: 1 }] } };
      }
      if (url.includes('/person/1/combined_credits')) {
        return {
          data: {
            cast: [
              {
                id: 11,
                title: 'Parasite',
                media_type: 'movie',
                vote_count: 1000,
                vote_average: 8.5,
                release_date: '2019-05-30',
              },
            ],
          },
        };
      }
      if (url.includes('/search/movie')) {
        return {
          data: {
            results: [
              {
                id: 11,
                title: 'Parasite',
                media_type: 'movie',
                popularity: 100,
                release_date: '2019-05-30',
              },
            ],
          },
        };
      }
      throw new Error(`unexpected axios url: ${url}`);
    });

    const azureChatVisionMock = jest
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          title: 'Parasite',
          type: 'movie',
          confidence: 'high',
          posterTitleReadable: true,
          billingName: '',
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          match: false,
          reason: 'confused',
          alternativeTitle: 'Parasite',
          alternativeType: 'movie',
        })
      );

    jest.doMock('axios', () => ({
      __esModule: true,
      default: {
        get: axiosGet,
      },
    }));

    jest.doMock('../services/azureLlm', () => ({
      isAzureLlmConfigured: jest.fn(() => true),
      azureChatText: jest.fn(),
      azureChatVision: azureChatVisionMock,
    }));

    jest.doMock('../services/rekognition', () => ({
      recognizeCelebrities: jest.fn(async () => [{ name: 'Song Kang-ho', confidence: 97 }]),
      extractImdbId: jest.fn(async () => null),
    }));

    const { identifyMovie } = await import('../services/movieService');
    const result = await identifyMovie(Buffer.from('poster').toString('base64'), 'image/jpeg');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identified.title).toBe('Parasite');
    }
  });
});
