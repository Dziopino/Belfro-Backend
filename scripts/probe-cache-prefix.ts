/*
 * Pomiar rozmiaru prefiksu cache i tokenów obrazu przez POST /v1/messages/count_tokens.
 * count_tokens tylko tokenizuje — nie generuje odpowiedzi i nie nalicza kosztu wygenerowanego wyniku.
 * Skrypt nic nie zapisuje w bazie; czyta wyłącznie answer_key sesji, żeby zmierzyć realny prefiks.
 *
 * Teksty promptów są KOPIAMI z src/services/aiGradingService.ts. Poniższy asert sprawdza,
 * że kopie nadal zgadzają się z plikiem — jeśli prompt się zmieni, skrypt się zatrzyma.
 */
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import prisma from '../src/config/database';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SYSTEM_PROMPT = `Jesteś profesjonalnym i sprawiedliwym egzaminatorem. Twoim zadaniem jest ocena zanonimizowanego sprawdzianu ucznia na podstawie dostarczonego Klucza Odpowiedzi.

Wytyczne:
- Analizuj treść merytoryczną, ignoruj drobne błędy ortograficzne, chyba że klucz odpowiedzi stanowi inaczej.
- Bądź precyzyjny w przyznawaniu punktów zgodnie z kryteriami.
- W polu 'confidence_score' zwróć liczbę od 0 do 100 określającą, jak pewny jesteś swojej oceny.
- Jeśli pismo odręczne jest nieczytelne, rozmazane lub brakuje stron, drastycznie obniż ten wskaźnik poniżej 70.
- Jeśli widzisz tylko część odpowiedzi lub obraz jest nieostry, obniż confidence_score.
- Komentarze pisz po polsku, ZWIĘŹLE (maksymalnie 2-3 zdania na zadanie), konstruktywnie.

KRYTYCZNE: Zwróć wyłącznie surowy obiekt JSON. NIE owijaj kodu w bloki markdown typu \`\`\`json \`\`\`. NIE dodawaj żadnych wstępów, nagłówków ani podsumowań. Odpowiedź musi zaczynać się od { i kończyć na }. Żadnego dodatkowego tekstu.`;

const USER_TEXT = 'Oceń tę pracę ucznia według klucza odpowiedzi podanego powyżej.';

function buildAnswerKeyBlock(answerKey: any): string {
  const tasks = answerKey.tasks || [];
  const totalPoints = answerKey.total_points || 0;

  let prompt = `**Klucz odpowiedzi:**\n`;
  prompt += `Maksymalna liczba punktów: ${totalPoints}\n\n`;

  tasks.forEach((task: any) => {
    prompt += `Zadanie ${task.id}: (${task.max_points} pkt)\n`;
    prompt += `Poprawna odpowiedź: ${task.correct_answer}\n`;
    if (task.guidelines) {
      prompt += `Wytyczne: ${task.guidelines}\n`;
    }
    prompt += `\n`;
  });

  return prompt;
}

function assertCopiesMatchSource() {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/services/aiGradingService.ts'), 'utf8');
  const markers = [SYSTEM_PROMPT.slice(0, 60), SYSTEM_PROMPT.slice(-80), USER_TEXT, '**Klucz odpowiedzi:**'];
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`Kopia prompta rozjechała się z aiGradingService.ts: "${marker.slice(0, 40)}..."`);
    }
  }
}

async function jpeg(width: number, height: number): Promise<string> {
  const px = Buffer.alloc(width * height * 3, 200);
  const buffer = await sharp(px, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  return buffer.toString('base64');
}

async function main() {
  assertCopiesMatchSource();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Brak ANTHROPIC_API_KEY w backend/.env');
  }

  const client = new Anthropic();
  const model = 'claude-haiku-5-5';

  const sessions = await prisma.gradingSession.findMany({
    select: { id: true, answer_key: true },
    orderBy: { created_at: 'desc' },
    take: 50,
  });

  const keys = sessions
    .map((s) => ({ id: s.id, key: s.answer_key as any }))
    .filter((s) => s.key && Array.isArray(s.key.tasks))
    .map((s) => ({ id: s.id, tasks: s.key.tasks.length, block: buildAnswerKeyBlock(s.key) }))
    .sort((a, b) => b.block.length - a.block.length);

  console.log(`Sesji z kluczem odpowiedzi: ${keys.length}\n`);

  const baseline = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: USER_TEXT }] }],
  });
  console.log(`Sama instrukcja per praca: ${baseline.input_tokens} tokenów\n`);

  console.log('PREFIKS (system + klucz odpowiedzi, blok z cache_control):');
  console.log('  zad  | znaki | tokeny prefiksu | >=1024 (Sonnet/Opus) | >=2048 (Haiku)');
  for (const item of keys) {
    const counted = await client.messages.countTokens({
      model,
      system: [
        { type: 'text', text: SYSTEM_PROMPT },
        { type: 'text', text: item.block, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: USER_TEXT }] }],
    });
    const prefixTokens = counted.input_tokens - baseline.input_tokens;
    const sonnet = prefixTokens >= 1024 ? 'TAK' : 'NIE';
    const haiku = prefixTokens >= 2048 ? 'TAK' : 'NIE';
    console.log(`  ${String(item.tasks).padStart(4)} | ${String(item.block.length).padStart(5)} | ${String(prefixTokens).padStart(15)} | ${sonnet.padStart(20)} | ${haiku.padStart(12)}`);
  }

  const systemOnly = await client.messages.countTokens({
    model,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'text', text: USER_TEXT }] }],
  });
  console.log(`\nSam system prompt (bez klucza): ${systemOnly.input_tokens - baseline.input_tokens} tokenów`);

  console.log('\nOBRAZ — ile tokenów płaci się za skan (bez cache, bo obraz jest zmienny):');
  for (const [w, h] of [[2676, 1836], [1568, 1076], [1000, 700]] as const) {
    const data = await jpeg(w, h);
    const counted = await client.messages.countTokens({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: USER_TEXT },
          ],
        },
      ],
    });
    console.log(`  ${w}x${h} (${((w * h) / 1e6).toFixed(2)} MP): ${counted.input_tokens - baseline.input_tokens} tokenów`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('BŁĄD:', err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
