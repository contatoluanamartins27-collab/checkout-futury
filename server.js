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
    ssl: { rejectUnauthorized: true }, // Obrigatório para TiDB
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.'))); // Serve o HTML

// --- ROTAS DO CHECKOUT ---

// 1. Buscar Produtos
app.get('/get_products.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM products WHERE active = 1 ORDER BY type DESC, id ASC");
        res.json(rows);
    } catch (error) {
        console.error(error);
        res.json([]);
    }
});

// 2. Salvar Cliente e Gerar Pix
app.post('/save_customer.php', async (req, res) => {
    const { customer, valueInCents } = req.body;
    try {
        // Salva no banco
        const [result] = await pool.execute(
            "INSERT INTO customers (name, phone, valor, status) VALUES (?, ?, ?, 'pendente')",
            [customer.name, customer.phone, valueInCents]
        );
        const customerId = result.insertId;

        // Gera Pix
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

        // Atualiza TXID
        await pool.execute('UPDATE customers SET txid = ? WHERE id = ?', [pixData.id, customerId]);

        res.json({ ...pixData, local_id: customerId });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// 3. Checar Status
app.get('/check_status.php', async (req, res) => {
    try {
        const [rows] = await pool.execute("SELECT status FROM customers WHERE id = ?", [req.query.id]);
        res.json({ status: rows.length > 0 ? rows[0].status : 'erro' });
    } catch (error) {
        res.json({ status: 'erro' });
    }
});

// --- ROTA WEBHOOK ---
app.post('/webhook', async (req, res) => {
    const { id, status } = req.body;
    if (status === 'paid' || status === 'approved') {
        try {
            await pool.execute('UPDATE customers SET status = "pago" WHERE txid = ?', [id]);
            console.log("Pagamento Confirmado:", id);
        } catch (e) { console.error(e); }
    }
    res.send('OK');
});

// --- ROTAS DO ADMIN ---

// Pegar dados gerais
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

// Criar/Editar Produtos
app.post('/api/admin-product', async (req, res) => {
    const { action, id, type, name, price, image, description } = req.body;
    try {
        let priceCents = price ? parseInt(parseFloat(price.replace(',', '.').replace('.', '')) * 100) : 0;

        if (action === 'create') {
            await pool.execute("INSERT INTO products (type, name, price, image_url, description, active) VALUES (?, ?, ?, ?, ?, 1)", [type, name, priceCents, image, description]);
        } else if (action === 'edit') {
            await pool.execute("UPDATE products SET type=?, name=?, price=?, image_url=?, description=? WHERE id=?", [type, name, priceCents, image, description, id]);
        } else if (action === 'delete') {
            await pool.execute("DELETE FROM products WHERE id=?", [id]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});