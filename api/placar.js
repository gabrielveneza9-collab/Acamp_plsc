// API do placar compartilhado do ACAMP PLSC (função da Vercel).
// GET  /api/placar                         -> { pacotes: { cafe: 25, ... }, ts }
// POST /api/placar { op: 'inc', id, delta } -> soma/subtrai pacotes (atômico)
// POST /api/placar { op: 'set', id, qty }   -> define a quantidade de um item
// POST /api/placar { op: 'setAll', values } -> define vários itens (zerar / desfazer)
//
// Guarda os dados no Redis da Upstash (integração da Vercel). Usa as variáveis
// KV_REST_API_URL / KV_REST_API_TOKEN ou UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.

const KEY = 'acamp-plsc:pacotes';
// Itens tabelados e quantidades iniciais (usadas só na primeira vez).
const INICIAL = { cafe: 25, oleo: 13, feijao: 8, leite: 21, sardinha: 8 };
const IDS = Object.keys(INICIAL);
const MAX = 100000;

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(commands) {
  const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!r.ok) throw new Error(`Redis respondeu ${r.status}`);
  const out = await r.json();
  for (const o of out) if (o && o.error) throw new Error(o.error);
  return out.map(o => o.result);
}

function toObject(flat) {
  const obj = {};
  for (let i = 0; i + 1 < (flat || []).length; i += 2) obj[flat[i]] = Number(flat[i + 1]) || 0;
  return obj;
}

async function lerPlacar() {
  let [flat] = await redis([['HGETALL', KEY]]);
  let dados = toObject(flat);
  const faltando = IDS.filter(id => !(id in dados));
  if (faltando.length) {
    // primeira vez (ou item novo): grava o valor inicial sem sobrescrever o que já existe
    const res = await redis([...faltando.map(id => ['HSETNX', KEY, id, String(INICIAL[id])]), ['HGETALL', KEY]]);
    dados = toObject(res[res.length - 1]);
  }
  const pacotes = {};
  for (const id of IDS) pacotes[id] = Math.max(0, Number(dados[id]) || 0);
  return pacotes;
}

const inteiro = v => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= MAX ? n : null;
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: 'banco-nao-configurado' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ pacotes: await lerPlacar(), ts: Date.now() });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'metodo-nao-permitido' });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return res.status(400).json({ error: 'corpo-invalido' });

    const { op } = body;
    if (op === 'inc') {
      const delta = Number(body.delta);
      if (!IDS.includes(body.id) || !Number.isInteger(delta) || Math.abs(delta) > 1000) {
        return res.status(400).json({ error: 'dados-invalidos' });
      }
      await lerPlacar(); // garante que o item já existe com o valor inicial
      const [novo] = await redis([['HINCRBY', KEY, body.id, String(delta)]]);
      if (Number(novo) < 0) await redis([['HSET', KEY, body.id, '0']]);
      else if (Number(novo) > MAX) await redis([['HSET', KEY, body.id, String(MAX)]]);
    } else if (op === 'set') {
      const qty = inteiro(body.qty);
      if (!IDS.includes(body.id) || qty === null) return res.status(400).json({ error: 'dados-invalidos' });
      await redis([['HSET', KEY, body.id, String(qty)]]);
    } else if (op === 'setAll') {
      const values = body.values && typeof body.values === 'object' ? body.values : {};
      const args = [];
      for (const id of IDS) {
        if (!(id in values)) continue;
        const qty = inteiro(values[id]);
        if (qty === null) return res.status(400).json({ error: 'dados-invalidos' });
        args.push(id, String(qty));
      }
      if (!args.length) return res.status(400).json({ error: 'dados-invalidos' });
      await redis([['HSET', KEY, ...args]]);
    } else {
      return res.status(400).json({ error: 'operacao-invalida' });
    }

    return res.status(200).json({ pacotes: await lerPlacar(), ts: Date.now() });
  } catch (err) {
    console.error('placar:', err);
    return res.status(500).json({ error: 'falha-no-banco' });
  }
};
