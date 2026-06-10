import 'dotenv/config';
import http from 'node:http';
import { Contract, rpc, TransactionBuilder, Networks, Address, Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import supabase from './database.js';
import { agregarCliente, eliminarCliente } from './sse.js';

const PORT = parseInt(process.env.API_PORT ?? '3002', 10);

// ─── Rate limiter: 3 solicitudes por wallet por hora ─────────────────────
const mapaRateLimit = new Map();
const RL_MAX = 3;
const RL_VENTANA_MS = 60 * 60 * 1000;

function verificarRateLimit(wallet) {
  const ahora = Date.now();
  const entradas = mapaRateLimit.get(wallet) || [];
  const recientes = entradas.filter(t => ahora - t < RL_VENTANA_MS);
  if (recientes.length >= RL_MAX) return false;
  recientes.push(ahora);
  mapaRateLimit.set(wallet, recientes);
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function responderJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('Cuerpo inválido: se esperaba JSON')); }
    });
    req.on('error', reject);
  });
}

// ─── Faucet — SOLO TESTNET ────────────────────────────────────────────────

const rpcFaucet      = new rpc.Server(process.env.STELLAR_RPC_URL, { allowHttp: false });
const tokenFaucet    = process.env.TOKEN_MXNE;
const secretFaucet   = process.env.FAUCET_SECRET;
const keypairFaucet  = secretFaucet ? Keypair.fromSecret(secretFaucet) : null;

async function mintearMXNe(destino, cantidad = BigInt(1_000_000_000)) {
  if (!secretFaucet || !keypairFaucet) throw new Error('Faucet no configurado (FAUCET_SECRET)');
  if (!tokenFaucet) throw new Error('Token MXNe no configurado (TOKEN_MXNE)');

  const contratoToken = new Contract(tokenFaucet);
  const cuentaInfo    = await rpcFaucet.getAccount(keypairFaucet.publicKey());

  const tx = new TransactionBuilder(cuentaInfo, {
    fee: '1000000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contratoToken.call('mint', new Address(destino).toScVal(), nativeToScVal(cantidad, { type: 'i128' })))
    .setTimeout(300)
    .build();

  const txPreparada = await rpcFaucet.prepareTransaction(tx);
  txPreparada.sign(keypairFaucet);

  const envio = await rpcFaucet.sendTransaction(txPreparada);
  if (envio.status === 'ERROR') throw new Error('Faucet tx rechazada por la red');

  let intentos = 0;
  while (intentos < 20) {
    await new Promise(r => setTimeout(r, 2000));
    const estado = await rpcFaucet.getTransaction(envio.hash);
    if (estado.status === rpc.Api.GetTransactionStatus.SUCCESS) return estado;
    if (estado.status === rpc.Api.GetTransactionStatus.FAILED)
      throw new Error('Faucet tx falló en la red');
    intentos++;
  }
  throw new Error('Timeout del faucet');
}

// ─── Rutas ────────────────────────────────────────────────────────────────

async function manejarRuta(req, res) {
  const url   = new URL(req.url, 'http://localhost');
  const partes = url.pathname.replace(/^\//, '').split('/');

  // POST /faucet
  if (req.method === 'POST' && partes[0] === 'faucet' && !partes[1]) {
    let body;
    try { body = await leerCuerpo(req); }
    catch (e) { return responderJSON(res, 400, { error: e.message }); }

    const { destino } = body;
    if (!destino) return responderJSON(res, 400, { error: 'Falta "destino" en el cuerpo' });

    if (!verificarRateLimit(destino))
      return responderJSON(res, 429, { error: 'Límite de 3 solicitudes por hora por wallet' });

    try {
      await mintearMXNe(destino);
      return responderJSON(res, 200, { exito: true, cantidad: 100 });
    } catch (e) {
      return responderJSON(res, 500, { error: e.message });
    }
  }

  if (req.method !== 'GET') return responderJSON(res, 405, { error: 'Método no permitido' });

  // GET /proyectos[?estado=X]
  if (partes[0] === 'proyectos' && !partes[1]) {
    let q = supabase.from('proyectos').select('*').order('id');
    if (url.searchParams.has('estado')) q = q.eq('estado', url.searchParams.get('estado'));
    const { data, error } = await q;
    return error ? responderJSON(res, 500, { error: error.message }) : responderJSON(res, 200, data);
  }

  // GET /proyectos/:id
  if (partes[0] === 'proyectos' && partes[1] && !partes[2]) {
    const { data, error } = await supabase
      .from('proyectos').select('*').eq('id', partes[1]).single();
    if (error) return responderJSON(res, error.code === 'PGRST116' ? 404 : 500, { error: error.message });
    return responderJSON(res, 200, data);
  }

  // GET /proyectos/:id/aportaciones
  if (partes[0] === 'proyectos' && partes[1] && partes[2] === 'aportaciones') {
    const { data, error } = await supabase
      .from('aportaciones').select('*').eq('proyecto_id', partes[1]).order('timestamp');
    return error ? responderJSON(res, 500, { error: error.message }) : responderJSON(res, 200, data);
  }

  // GET /backers/:address/aportaciones
  if (partes[0] === 'backers' && partes[1] && partes[2] === 'aportaciones') {
    const { data, error } = await supabase
      .from('aportaciones').select('*, proyectos(nombre,estado)')
      .eq('contribuidor', partes[1]).order('timestamp');
    return error ? responderJSON(res, 500, { error: error.message }) : responderJSON(res, 200, data);
  }

  // GET /eventos[?tipo=X&limit=N]
  if (partes[0] === 'eventos' && !partes[1]) {
    const limite = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    let q = supabase.from('eventos').select('*').order('ledger', { ascending: false }).limit(limite);
    if (url.searchParams.has('tipo')) q = q.eq('tipo', url.searchParams.get('tipo'));
    const { data, error } = await q;
    return error ? responderJSON(res, 500, { error: error.message }) : responderJSON(res, 200, data);
  }

  // GET /stats
  if (partes[0] === 'stats' && !partes[1]) {
    const [proyectos, aportaciones] = await Promise.all([
      supabase.from('proyectos').select('estado,total_aportado,yield_entregado,meta'),
      supabase.from('aportaciones').select('monto,retirado'),
    ]);
    if (proyectos.error) return responderJSON(res, 500, { error: proyectos.error.message });

    const ps = proyectos.data;
    const stats = {
      total_proyectos: ps.length,
      activos:         ps.filter(p => ['EtapaInicial', 'EnProgreso', 'Liberado'].includes(p.estado)).length,
      total_aportado:  ps.reduce((s, p) => s + Number(p.total_aportado ?? 0), 0),
      total_yield:     ps.reduce((s, p) => s + Number(p.yield_entregado ?? 0), 0),
      capital_activo:  (aportaciones.data ?? [])
                         .filter(a => !a.retirado)
                         .reduce((s, a) => s + Number(a.monto ?? 0), 0),
    };
    return responderJSON(res, 200, stats);
  }

  // GET /sse — Server-Sent Events stream
  if (partes[0] === 'sse' && !partes[1]) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': process.env.FRONTEND_URL || '*',
    });
    res.write(':ok\n\n');
    agregarCliente(res);
    req.on('close', () => eliminarCliente(res));
    return;
  }

  responderJSON(res, 404, { error: 'No encontrado' });
}

const servidor = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  try {
    await manejarRuta(req, res);
  } catch (err) {
    responderJSON(res, 500, { error: err.message });
  }
});

servidor.listen(PORT, () => console.log(`Anchorfund API escuchando en el puerto ${PORT}`));
