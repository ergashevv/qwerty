import {
  RekognitionClient,
  RecognizeCelebritiesCommand,
} from '@aws-sdk/client-rekognition';

const client = new RekognitionClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

export interface CelebrityResult {
  name: string;
  confidence: number;
  imdbUrl?: string;
}

export async function recognizeCelebrities(imageBase64: string): Promise<CelebrityResult[]> {
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return [];
  }

  try {
    const imageBytes = Buffer.from(imageBase64, 'base64');
    const command = new RecognizeCelebritiesCommand({
      Image: { Bytes: imageBytes },
    });

    const response = await client.send(command);
    const celebrities = response.CelebrityFaces || [];

    return celebrities
      .filter(c => (c.MatchConfidence ?? 0) >= 70 && c.Name)
      .map(c => ({
        name: c.Name!,
        confidence: c.MatchConfidence ?? 0,
        imdbUrl: c.Urls?.find(u => u.includes('imdb.com')),
      }))
      .sort((a, b) => b.confidence - a.confidence);
  } catch (err) {
    console.warn('Rekognition xato:', (err as Error).message?.slice(0, 80));
    return [];
  }
}

export function extractImdbId(imdbUrl?: string): string | null {
  if (!imdbUrl) return null;
  const match = imdbUrl.match(/nm(\d+)/);
  return match ? `nm${match[1]}` : null;
}
