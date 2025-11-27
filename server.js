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

// --- CONFIGURAÇÕES IMPORTANTES (MIDDLEWARES) ---
app.use(cors());

// Permite receber JSON
app.use(express.json()); 

// Permite receber dados de formulário (Correção para o erro undefined)
app.use(express.urlencoded({ extended: true })); 

app.use(express.static(path.join(__dirname, '.')));

// --- ROTA: WEBHOOK (CORRIGIDA) ---
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔔 Webhook recebido!");
        
        // Verificação de segurança: Se o corpo vier vazio, não quebra o servidor
        if (!req.body) {
            console.error("❌ Erro: Corpo da requisição vazio (undefined)");
            return res.status(400).json({ error: "No body received" });
        }

        console.log("📦 Dados recebidos:", JSON.stringify(req.body, null, 2));

        // Tenta pegar os dados de várias formas possíveis
        const id = req.body.id || req.body.transaction_id;
        const status = req.body.status;

        if (!id) {
            console.error("❌ Erro: ID não encontrado no webhook");
            return res.status(200).send('ID missing but received'); // Retorna 200 pra não travar a API deles
        }

        const statusLower = status ? status.toLowerCase() : '';

        if (statusLower === 'paid' || statusLower === 'approved') {
            console.log(`✅ Pagamento APROVADO. Atualizando TXID: ${id}`);
            
            // Atualiza para PAGO
            const [updateResult] = await pool.query(
                'UPDATE customers SET status = "pago" WHERE txid = ?', 
                [id]
            );
            console.log("Linhas atualizadas:", updateResult.affectedRows);
        } else {
            console.log(`ℹ️ Status recebido: ${status} (Não é aprovação)`);
        }

        res.status(200).json({ received: true });

    } catch (error) {
        console.error("❌ ERRO CRÍTICO NO WEBHOOK:", error);
        res.status(500).json({ error: error.message });
    }
});

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
        const [result] = await pool.query(
            "INSERT INTO customers (name, phone, valor, status) VALUES (?, ?, ?, 'pendente')",
            [customer.name, customer.phone, valueInCents]
        );
        const customerId = result.insertId;

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

        await pool.query('UPDATE customers SET txid = ? WHERE id = ?', [pixData.id, customerId]);

        res.json({ ...pixData, local_id: customerId });

    } catch (error) {
        console.error("Erro criar pix:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- ROTA: CHECAR STATUS ---
app.get('/check_status.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT status FROM customers WHERE id = ?", [req.query.id]);
        res.json({ status: rows.length > 0 ? rows[0].status : 'erro' });
    } catch (error) {
        res.json({ status: 'erro' });
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
