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
app.use(express.urlencoded({ extended: true })); 
app.use(express.static(path.join(__dirname, '.')));

// --- ROTA: WEBHOOK (VERSÃO FINAL BLINDADA) ---
app.post('/webhook', async (req, res) => {
    try {
        console.log("🔔 WEBHOOK CHEGOU!");
        const { id, status, transaction_id } = req.body;
        
        // Pega o ID e força para minúsculo para garantir compatibilidade
        let txid = (id || transaction_id);
        
        const statusLower = status ? status.toLowerCase() : '';

        console.log(`📦 ID Recebido: ${txid} | Status: ${statusLower}`);

        if (statusLower === 'paid' || statusLower === 'approved') {
            
            // TENTA ATUALIZAR (Ignorando maiúsculas/minúsculas no banco)
            // Usamos LOWER(txid) no SQL para garantir que bata com o que salvamos
            const [result] = await pool.query('UPDATE customers SET status = "pago" WHERE txid = ? OR txid = ?', [txid, txid.toLowerCase()]);
            
            if (result.affectedRows > 0) {
                console.log(`✅ Sucesso! Pedido ${txid} marcado como PAGO.`);
            } else {
                console.log(`⚠️ ID não encontrado direto. Tentando pelo valor...`);
                
                // FALLBACK DE SEGURANÇA (Caso o ID falhe)
                if(req.body.value) {
                    const valorInt = parseInt(req.body.value); 
                    const [rescue] = await pool.query('UPDATE customers SET status = "pago", txid = ? WHERE valor = ? AND status = "pendente" ORDER BY id DESC LIMIT 1', [txid, valorInt]);
                    if(rescue.affectedRows > 0) {
                        console.log("✅ SALVO PELO GONGO! Atualizado pelo valor.");
                    } else {
                        console.error("❌ ERRO: Pedido não encontrado nem pelo ID nem pelo Valor.");
                    }
                }
            }
        }
        res.status(200).json({ received: true });
    } catch (error) {
        console.error("❌ ERRO WEBHOOK:", error);
        res.status(500).json({ error: error.message });
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

        // Salva o ID exatamente como veio da API
        if (pixData.id) {
            await pool.query('UPDATE customers SET txid = ? WHERE id = ?', [pixData.id, customerId]);
        }

        res.json({ ...pixData, local_id: customerId });

    } catch (error) {
        console.error("Erro ao criar:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- OUTRAS ROTAS (IGUAIS) ---
app.get('/get_products.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM products WHERE active = 1 ORDER BY type DESC, id ASC");
        res.json(rows);
    } catch (error) { res.json([]); }
});

app.get('/check_status.php', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT status FROM customers WHERE id = ?", [req.query.id]);
        res.json({ status: rows.length > 0 ? rows[0].status : 'erro' });
    } catch (error) { res.json({ status: 'erro' }); }
});

app.get('/api/admin-data', async (req, res) => {
    try {
        const [pago] = await pool.query("SELECT SUM(valor) as total, COUNT(*) as qtd FROM customers WHERE status = 'pago'");
        const [pend] = await pool.query("SELECT SUM(valor) as total, COUNT(*) as qtd FROM customers WHERE status != 'pago'");
        const [vendas] = await pool.query("SELECT * FROM customers ORDER BY id DESC LIMIT 20");
        const [prods] = await pool.query("SELECT * FROM products ORDER BY id ASC");
        res.json({ pago: pago[0], pendente: pend[0], ultimas_vendas: vendas, produtos: prods });
    } catch (error) { res.status(500).json({ error: error.message }); }
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
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
