/*
 * server.js — Backend Pomodoro + Groq IA (PostgreSQL Edition)
 *
 * Mantém EXATAMENTE as mesmas rotas e formatos de entrada/saída do original,
 * mas agora utiliza PostgreSQL (Supabase) para persistência definitiva no Render.
 *
 * Instalar antes: npm install express cors pg
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Client } = require("pg"); // Alterado de better-sqlite3 para pg

const PORT = process.env.PORT || 3000;

// Configuração da conexão com o banco de dados remoto
// Em produção, o Render vai preencher process.env.DATABASE_URL automaticamente
const db = new Client({
  connectionString: process.env.DATABASE_URL || "postgres://usuario:senha@localhost:5432/nome_do_banco",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false // Ativa SSL apenas em produção
});

// Conecta ao banco de dados remoto
db.connect()
  .then(() => console.log("[DATABASE] Conectado ao PostgreSQL com sucesso!"))
  .catch(err => console.error("[DATABASE] Erro ao conectar ao PostgreSQL:", err));

// Inicialização das tabelas usando sintaxe válida do PostgreSQL
const inicializarTabelas = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        senha TEXT NOT NULL
      );
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS sessoes (
        id SERIAL PRIMARY KEY,
        usuario_id INTEGER NOT NULL,
        duracao_seg INTEGER NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DATABASE] Tabelas verificadas/criadas.");
  } catch (err) {
    console.error("[DATABASE] Erro ao criar tabelas:", err);
  }
};
inicializarTabelas();

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ── Funções de Criptografia (PBKDF2 + Salt) ──────────────────
function gerarHashSenha(senhaPura) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(senhaPura, salt, 1000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verificarSenha(senhaDigitada, senhaArmazenada) {
  try {
    const [salt, hashOriginal] = senhaArmazenada.split(":");
    const hashDigitado = crypto.pbkdf2Sync(senhaDigitada, salt, 1000, 64, "sha512").toString("hex");
    return hashOriginal === hashDigitado;
  } catch (err) {
    return false;
  }
}

// ── app ──────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── rota: cadastro (Assíncrona) ──────────────────────────────
app.post("/cadastro", async (req, res) => {
  const { nome, email, senha } = req.body || {};

  if (!nome || !email || !senha) {
    return res.json({ ok: false, msg: "Campos faltando" });
  }

  try {
    const senhaHashSegura = gerarHashSenha(senha);
    
    // Sintaxe do Postgres usa $1, $2, $3 em vez de ?
    await db.query(
      "INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3);",
      [nome, email, senhaHashSegura]
    );
    
    return res.json({ ok: true, msg: "Conta criada!" });
  } catch (err) {
    // Código de erro do Postgres para violação de UNIQUE (e-mail duplicado) é '23505'
    return res.json({ ok: false, msg: "Erro ou email duplicado" });
  }
});

// ── rota: login (Assíncrona) ──────────────────────────────────
app.post("/login", async (req, res) => {
  const { email, senha } = req.body || {};

  if (!email || !senha) {
    return res.json({ ok: false, msg: "Campos faltando" });
  }

  try {
    const result = await db.query(
      "SELECT id, nome, senha FROM usuarios WHERE email = $1 LIMIT 1;",
      [email]
    );

    const row = result.rows[0]; // No pg, os dados ficam dentro de .rows

    if (row && verificarSenha(senha, row.senha)) {
      return res.json({ ok: true, id: row.id, nome: row.nome });
    }
    
    return res.json({ ok: false, msg: "Incorreto" });
  } catch (err) {
    return res.json({ ok: false, msg: "Erro interno" });
  }
});

// ── rota: salvar sessão de estudo (Assíncrona) ────────────────
app.post("/salvar_sessao", async (req, res) => {
  const { usuario_id, duracao_seg } = req.body || {};

  if (usuario_id === undefined || duracao_seg === undefined) {
    return res.json({ ok: false });
  }

  try {
    await db.query(
      "INSERT INTO sessoes (usuario_id, duracao_seg) VALUES ($1, $2);",
      [parseInt(usuario_id, 10), parseInt(duracao_seg, 10)]
    );
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false });
  }
});

// ── rota: tempo total de estudo (Assíncrona) ──────────────────
app.get("/tempo_total", async (req, res) => {
  const usuarioId = parseInt(req.query.usuario_id, 10);

  if (!usuarioId) {
    return res.json({ ok: false });
  }

  try {
    const result = await db.query(
      "SELECT COALESCE(SUM(duracao_seg),0) AS total, COUNT(*) AS sessoes FROM sessoes WHERE usuario_id = $1;",
      [usuarioId]
    );
    
    const row = result.rows[0];

    return res.json({
      ok: true,
      total_seg: parseInt(row.total, 10),
      total_min: Math.floor(parseInt(row.total, 10) / 60),
      sessoes: parseInt(row.sessoes, 10),
    });
  } catch (err) {
    return res.json({ ok: false });
  }
});

// ── rota: proxy para a IA (Groq) ─────────────────────────────
app.post("/ia", async (req, res) => {
  try {
    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await groqRes.json();
    return res.status(groqRes.status).json(data);
  } catch (err) {
    return res.json({ ok: false, msg: "Erro de conexao com a API externa" });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, msg: "Erro" });
});

app.listen(PORT, () => {
  console.log(`[SERVER] Servidor rodando na porta ${PORT}`);
});