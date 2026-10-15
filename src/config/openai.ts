import OpenAI from 'openai';

// Inicjalizacja klienta OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export default openai;
