require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;

// Conexão com o Banco TiDB
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: { rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

// --- ROTA: BUSCAR PRODUTOS ---
app.get('/get_products.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM products WHERE active = 1 ORDER BY type DESC, id ASC");
        res.json(rows);
    } catch (error) {
        console.error("Erro produtos:", error);
        res.json([]);
    }
});

// --- ROTA: SALVAR CLIENTE E GERAR PIX ---
app.post('/save_customer.php', async (req, res) => {
    const { customer, valueInCents } = req.body;
    try {
        // 1. Salva cliente
        const [result] = await pool.query(
            "INSERT INTO customers (name, phone, valor, status) VALUES (?, ?, ?, 'pendente')",
            [customer.name, customer.phone, valueInCents]
        );
        const customerId = result.insertId;

        // 2. Gera Pix na PushInPay
        const webhookUrl = `${process.env.BASE_URL}/webhook`;
        const pushRes = await fetch('https://api.pushinpay.com.br/api/pix/cashIn', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.PUSHINPAY_TOKEN}`,
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ value: valueInCents, webhook_url: webhookUrl })
        });

        const pixData = await pushRes.json();
        if (!pushRes.ok) throw new Error(pixData.message || 'Erro API Pix');

        // 3. Atualiza TXID no banco
        await pool.query('UPDATE customers SET txid = ? WHERE id = ?', [pixData.id, customerId]);

        res.json({ ...pixData, local_id: customerId });

    } catch (error) {
        console.error("Erro criar pix:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- ROTA: CHECAR STATUS (Para o Checkout) ---
app.get('/check_status.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT status FROM customers WHERE id = ?", [req.query.id]);
        res.json({ status: rows.length > 0 ? rows[0].status : 'erro' });
    } catch (error) {
        res.json({ status: 'erro' });
    }
});

// --- ROTA: WEBHOOK (CORRIGIDA E BLINDADA) ---
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔔 Webhook recebido:", req.body); // Vai aparecer no Log do Render

        const { id, status, transaction_id } = req.body;
        
        // O ID da transação pode vir como 'id' ou 'transaction_id'
        const txid = id || transaction_id;
        
        // Normaliza o status (para minúsculo)
        const statusLower = status ? status.toLowerCase() : '';

        if (statusLower === 'paid' || statusLower === 'approved') {
            console.log(`Tentando aprovar TXID: ${txid}`);
            
            // Atualiza para PAGO
            const [updateResult] = await pool.query(
                'UPDATE customers SET status = "pago" WHERE txid = ?', 
                [txid]
            );
            
            console.log("Linhas afetadas no banco:", updateResult.affectedRows);
        }

        // Retorna 200 OK para a PushInPay parar de mandar erro
        res.status(200).json({ received: true });

    } catch (error) {
        console.error("❌ ERRO NO WEBHOOK:", error);
        // Retornamos 500 aqui só para você ver o erro no painel da PushInPay se der ruim
        res.status(500).json({ error: error.message });
    }
});

// --- ROTAS DO ADMIN ---
app.get('/api/admin-data', async (req, res) => {
    try {
        const [pago] = await pool.query("SELECT SUM(valor) as total, COUNT(*) as qtd FROM customers WHERE status = 'pago'");
        const [pend] = await pool.query("SELECT SUM(valor) as total, COUNT(*) as qtd FROM customers WHERE status != 'pago'");
        const [vendas] = await pool.query("SELECT * FROM customers ORDER BY id DESC LIMIT 20");
        const [prods] = await pool.query("SELECT * FROM products ORDER BY id ASC");

        res.json({ pago: pago[0], pendente: pend[0], ultimas_vendas: vendas, produtos: prods });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/admin-product', async (req, res) => {
    const { action, id, type, name, price, image, description } = req.body;
    try {
        let priceCents = price ? parseInt(parseFloat(price.replace(',', '.').replace('.', '')) * 100) : 0;

        if (action === 'create') {
            await pool.query("INSERT INTO products (type, name, price, image_url, description, active) VALUES (?, ?, ?, ?, ?, 1)", [type, name, priceCents, image, description]);
        } else if (action === 'edit') {
            await pool.query("UPDATE products SET type=?, name=?, price=?, image_url=?, description=? WHERE id=?", [type, name, priceCents, image, description, id]);
        } else if (action === 'delete') {
            await pool.query("DELETE FROM products WHERE id=?", [id]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
