/**
 * Uproszczony test prompt caching – bez structured outputs
 */
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

function buildSystemPrompt(): string {
  return `Jesteś profesjonalnym i sprawiedliwym egzaminatorem. Twoim zadaniem jest ocena zanonimizowanego sprawdzianu ucznia na podstawie dostarczonego Klucza Odpowiedzi.

Wytyczne:
- Analizuj treść merytoryczną, ignoruj drobne błędy ortograficzne, chyba że klucz odpowiedzi stanowi inaczej.
- Bądź precyzyjny w przyznawaniu punktów zgodnie z kryteriami.
- W polu 'confidence_score' zwróć liczbę od 0 do 100 określającą, jak pewny jesteś swojej oceny.
- Jeśli pismo odręczne jest nieczytelne, rozmazane lub brakuje stron, drastycznie obniż ten wskaźnik poniżej 70.
- Jeśli widzisz tylko część odpowiedzi lub obraz jest nieostry, obniż confidence_score.
- Komentarze pisz po polsku, ZWIĘŹLE (maksymalnie 2-3 zdania na zadanie), konstruktywnie.

KRYTYCZNE: Zwróć wyłącznie surowy obiekt JSON. NIE owijaj kodu w bloki markdown typu \`\`\`json \`\`\`. NIE dodawaj żadnych wstępów, nagłówków ani podsumowań. Odpowiedź musi zaczynać się od { i kończyć na }. Żadnego dodatkowego tekstu.`;
}

function buildAnswerKeyBlock(): string {
  return `**Klucz odpowiedzi:**
Maksymalna liczba punktów: 20

Zadanie 1: (5 pkt)
Poprawna odpowiedź: Fotosynteza to proces, w którym rośliny wykorzystują światło słoneczne do wytwarzania glukozy z dwutlenku węgla i wody.
Wytyczne: Przyznaj pełne punkty za wymienienie wszystkich trzech elementów: światło, CO2, H2O. Za niepełną odpowiedź odejmij punkty proporcjonalnie.

Zadanie 2: (5 pkt)
Poprawna odpowiedź: Mitochondria to organella komórkowe odpowiedzialne za produkcję ATP w procesie oddychania komórkowego.
Wytyczne: Kluczowe: mitochondria + ATP + oddychanie komórkowe. Każdy brakujący element -1pkt.

Zadanie 3: (5 pkt)
Poprawna odpowiedź: DNA jest zbudowane z dwóch nici nukleotydów połączonych wiązaniami wodorowymi, tworzących strukturę podwójnej helisy.
Wytyczne: Odpowiedź musi zawierać: dwie nici, nukleotydy, podwójna helisa. Brak jednego elementu -2pkt.

Zadanie 4: (5 pkt)
Poprawna odpowiedź: Rybosom to struktura komórkowa odpowiedzialna za syntezę białek na podstawie informacji zawartej w mRNA.
Wytyczne: Pełne punkty: rybosom + synteza białek + mRNA. Niepełna odpowiedź -2pkt.`;
}

function createSyntheticJPEG(outputPath: string) {
  // Minimalny poprawny JPEG (1x1 piksel biały)
  const minimalJPEG = Buffer.from([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09, 0x09,
    0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12, 0x13, 0x0F, 0x14, 0x1D,
    0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20, 0x22, 0x2C, 0x23,
    0x1C, 0x1C, 0x28, 0x37, 0x29, 0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27, 0x39, 0x3D,
    0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32,
    0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
    0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04,
    0x00, 0x00, 0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41,
    0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42,
    0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17,
    0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77,
    0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95,
    0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2,
    0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8,
    0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4,
    0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xFE, 0xA2, 0x80,
    0xFF, 0xD9,
  ]);

  fs.writeFileSync(outputPath, minimalJPEG);
}

async function testCache(model: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const anthropic = new Anthropic({ apiKey });

  const tmpDir = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const imagePath = path.join(tmpDir, 'test-cache.jpg');
  createSyntheticJPEG(imagePath);

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const systemPrompt = buildSystemPrompt();
  const answerKeyBlock = buildAnswerKeyBlock();

  console.log(`\n📏 Prefix estimate: system=${systemPrompt.length} chars, key=${answerKeyBlock.length} chars, total=${systemPrompt.length + answerKeyBlock.length} chars (~${Math.ceil((systemPrompt.length + answerKeyBlock.length) / 4)} tokens)`);

  // WYWOŁANIE 1
  console.log(`\n🧪 Call 1 to ${model} (cache creation expected)...`);
  const msg1 = await anthropic.messages.create({
    model: model,
    max_tokens: 1024,
    system: [
      { type: 'text', text: systemPrompt },
      { type: 'text', text: answerKeyBlock, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: 'Oceń tę pracę ucznia według klucza odpowiedzi podanego powyżej.' },
        ],
      },
    ],
  });

  console.log(`📊 Usage 1: input=${msg1.usage.input_tokens}, cache_read=${msg1.usage.cache_read_input_tokens || 0}, cache_create=${msg1.usage.cache_creation_input_tokens || 0}, output=${msg1.usage.output_tokens}`);

  // WYWOŁANIE 2
  console.log(`\n🧪 Call 2 to ${model} (cache read expected)...`);
  const msg2 = await anthropic.messages.create({
    model: model,
    max_tokens: 1024,
    system: [
      { type: 'text', text: systemPrompt },
      { type: 'text', text: answerKeyBlock, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: 'Oceń tę pracę ucznia według klucza odpowiedzi podanego powyżej.' },
        ],
      },
    ],
  });

  console.log(`📊 Usage 2: input=${msg2.usage.input_tokens}, cache_read=${msg2.usage.cache_read_input_tokens || 0}, cache_create=${msg2.usage.cache_creation_input_tokens || 0}, output=${msg2.usage.output_tokens}`);

  console.log(`\n✅ Summary for ${model}:`);
  console.log(`   Prefix tokens (measured): ${msg1.usage.cache_creation_input_tokens || 0}`);
  console.log(`   Cache hit on 2nd call: ${(msg2.usage.cache_read_input_tokens || 0) > 0 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`   Cache read tokens: ${msg2.usage.cache_read_input_tokens || 0}`);

  fs.unlinkSync(imagePath);
}

async function main() {
  console.log('🚀 Testing prompt caching with Anthropic\n');

  try {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('Testing: claude-haiku-5-5');
    console.log('═══════════════════════════════════════════════════════════');
    await testCache('claude-haiku-5-5');
  } catch (e: any) {
    console.error('❌ Haiku test failed:', e.message || e);
  }

  try {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('Testing: claude-sonnet-5-5');
    console.log('═══════════════════════════════════════════════════════════');
    await testCache('claude-sonnet-5-5');
  } catch (e: any) {
    console.error('❌ Sonnet test failed:', e.message || e);
  }
}

main().catch(console.error);
