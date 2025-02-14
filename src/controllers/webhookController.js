const { sendWhatsAppMessage, sendWhatsAppList, sendProactiveMessage } = require('../services/whatsappService');
const db = require('../config/db');
const userFlows = require('../state/userFlows');
const { createOrder } = require('./createOrderController');
const stripe = require('stripe')('sk_test_51QRIsnRoyF58F5zaRv3NUpM8zUw6j3uulTnvqG4ZwlE3nXbsOWOwjUcuSGyoZH10bPbm4ARN7LX3Ou1Qkf27IJDi00Q6OeFDN0');
const axios = require('axios');

// Verificação do webhook
exports.verifyWebhook = (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('Webhook verified');
            return res.status(200).send(challenge);
        } else {
            return res.status(403).send('Forbidden');
        }
    }
    res.status(400).send('Bad Request');
};

exports.handleMessage = (req, res) => {
    const body = req.body;
    const entry = body.entry?.[0]?.changes?.[0]?.value;
    const messageObject = entry?.messages?.[0];

    if (!messageObject) {
        console.log('Mensagem não encontrada.');
        return res.sendStatus(404);
    }

    const { phone_number_id } = entry.metadata;
    console.log('Numero de celular que enviou, bot:', phone_number_id);
    const from = messageObject.from;

    console.log('Mensagem recebida:', messageObject);
    console.log('Estado do usuário:', userFlows[from]);

    if (messageObject.interactive?.type === 'button_reply') {
        const buttonResponse = messageObject.interactive.button_reply.id;
        console.log(`Interação do usuário ${from}: ${buttonResponse}`);

        if (buttonResponse === 'buy') {
            if (userFlows[from]?.status === 'cart') {
                continueShopping(phone_number_id, from, res);
            } else {
                startBuyFlow(phone_number_id, from, res);
            }
        } else if (buttonResponse === 'checkout') {
            askForLocation(phone_number_id, from, res);
        } else if (buttonResponse === 'confirm_purchase') {
            confirmPurchase(phone_number_id, from, res);
        } else if (buttonResponse === 'help') {
            requestMessageToIa(phone_number_id, from, res);
        } else if (buttonResponse === 'view_orders') {
            viewOrders(phone_number_id, from, res);
        } else if (buttonResponse === 'order_finished') {
            sendProactiveMessage(from, `Muito obrigado por comprar conosco, tenha um otimo dia`);
        } else if (buttonResponse === 'order_not_finished') {
            sendProactiveMessage(from, `Estamos analisando o ocorrido e tomaremos medidos o mais rapido possivel`);
        }
        else {
            res.sendStatus(200);
        }
    }
    else if (messageObject.interactive?.type === 'list_reply') {
        const selectedProductId = messageObject.interactive.list_reply.id;
        console.log(`Produto selecionado pelo usuário ${from}: ${selectedProductId}`);

        if (userFlows[from]?.status === 'awaiting_product') {
            addToCart(phone_number_id, from, selectedProductId, res);
        } else {
            sendWhatsAppMessage(phone_number_id, from, 'Por favor, inicie uma compra para selecionar um produto.', res);
        }
    }
    else if (messageObject.text) {
        const userText = messageObject.text.body.toLowerCase();

        // Se não existir um fluxo para esse usuário, inicializa um fluxo padrão
        if (!userFlows[from]) {
            userFlows[from] = { status: 'awaiting_product', cart: [] };
            // sendWelcomeOptions(phone_number_id, from, res);
            sendWelcomeMessage(phone_number_id, from, res)
            return;
        }

        // Lógica para o fluxo de "ajuda com remédios" (solicitando sintomas)
        if (userFlows[from]?.status === 'sending_symptoms') {
            if (userText.trim() === '') {
                sendWhatsAppMessage(phone_number_id, from, 'Por favor, descreva seus sintomas para que possamos ajudar.', res);
            } else {
                sendWhatsAppMessage(phone_number_id, from, 'Recebemos seus sintomas. Consultando a IA...', res);
                requestHelpFromAI(phone_number_id, from, userText, res);
            }
        }
        else if (userFlows[from]?.status === 'requesting') {
            requestHelpFromAIChat(phone_number_id, from, userText, res);
        }

        // Lógica para o fluxo de "compra de produto"
        else if (userFlows[from]?.status === 'awaiting_product') {
            if (userText.trim() === '') {
                sendWhatsAppMessage(phone_number_id, from, 'Por favor, informe o nome do produto que deseja comprar.', res);
            } else {
                processBuyRequest(phone_number_id, from, userText, res);
            }
        }
        else if (userFlows[from]?.status === 'cart') {
            if (userText === 'continuar') {
                continueShopping(phone_number_id, from, res);
            } else if (userText === 'finalizar') {
                askForLocation(phone_number_id, from, res);
            } else {
                sendWhatsAppMessage(phone_number_id, from, 'Resposta inválida. Por favor, responda com "continuar" ou "finalizar".', res);
            }
        } else {
            sendWelcomeOptions(phone_number_id, from, res);
        }
    }
    else if (messageObject.location) {  // Verificação para localização
        const location = messageObject.location;
        console.log(`Localização recebida do usuário ${from}:`, location);
        console.log(userFlows[from]?.status);

        if (userFlows[from]?.status === 'awaiting_location') {
            processLocation(phone_number_id, from, location, res);
        } else {
            sendWhatsAppMessage(phone_number_id, from, 'Localização recebida, mas nenhuma compra em andamento.', res);
        }
    }
};

// Envia as opções de boas-vindas
const sendWelcomeOptions = (phone_number_id, from, res) => {
    sendWhatsAppMessage(phone_number_id, from, 'Bem-vindo ao Sauris, como podemos te ajudar hoje?', res, [
        { id: 'buy', title: 'Comprar medicamentos' },
        { id: 'help', title: 'Buscar Orientação' },
        { id: 'view_orders', title: 'Ver pedidos' }
    ], false, 'Bem-vindo ao Sauris');
};

const sendWelcomeMessage = (phone_number_id, from, res) => {
    if (!userFlows[from]) {
        userFlows[from] = { status: 'requesting', cart: [] };
    } else {
        userFlows[from].status = 'requesting';
    }
    sendWhatsAppMessage(
        phone_number_id,
        from,
        'Olá, estou aqui para te auxiliar, me diga o que você deseja fazer hoje?',
        res
    );

};


const requestMessageToIa = async (phone_number_id, from, res) => {
    if (!userFlows[from]) {
        userFlows[from] = { status: 'sending_symptoms', cart: [] };
    } else {
        userFlows[from].status = 'sending_symptoms';
    }

    const helpMessage = "Descreva seus sintomas e recomendaremos um profissional mais indicado para o seu caso."

    sendWhatsAppMessage(phone_number_id, from, helpMessage, res);
}

const requestHelpFromAI = async (phone_number_id, from, symptoms, res) => {
    try {
        const response = await axios.post('https://ia-hygia.onrender.com/recomendar', {
            sintomas: symptoms
        });

        const aiResponse = response.data.remedio;

        sendProactiveMessage(from, `Com os sintomas que você descreveu, a IA recomenda que você consulte um: ${aiResponse}.`);

        userFlows[from].status = '';

    } catch (error) {
        console.error('Erro ao chamar a API Python:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Desculpe, houve um erro ao processar seus sintomas. Tente novamente mais tarde.', res);
    }
};


const requestHelpFromAIChat = async (phone_number_id, from, symptoms, res) => {
    try {
        const response = await axios.post('https://ia-hygia.onrender.com/chat', {
            mensagem: symptoms
        });

        const aiResponse = response.data.funcao;

        if (aiResponse === 'requestMessageToIa') {
            if (!userFlows[from]) {
                userFlows[from] = { status: 'sending_symptoms', cart: [] };
            } else {
                userFlows[from].status = 'sending_symptoms';
            }
            requestMessageToIa(phone_number_id, from, res);
        } else if (aiResponse === 'viewOrders') {
            if (!userFlows[from]) {
                userFlows[from] = { status: '', cart: [] };
            } else {
                userFlows[from].status = '';
            }
            viewOrders(phone_number_id, from, res);
        } else if (aiResponse === 'startBuyFlow') {
            if (!userFlows[from]) {
                userFlows[from] = { status: 'awaiting_product', cart: [] };
            } else {
                userFlows[from].status = 'awaiting_product';
            }
            startBuyFlow(phone_number_id, from, res);
        } else {
            sendWhatsAppMessage(phone_number_id, from, 'Desculpe, houve um problema. Tente novamente mais tarde.', res);
        }

    } catch (error) {
        console.error('Erro ao chamar a API Python:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Desculpe, houve um erro ao processar seus sintomas. Tente novamente mais tarde.', res);
    }
};

// Função para ver pedidos anteriores
const viewOrders = async (phone_number_id, from, res) => {
    try {
        // Consultar apenas os pedidos finalizados (status 'f')
        const [rows] = await db.execute(
            `SELECT o.id, o.status, o.total, o.created_at, p.pharmacyName AS pharmacy_name
            FROM orders o
            JOIN pharmacys p ON o.pharmacy_id = p.id
            WHERE o.user_phone = ? AND o.status = 'f'
            ORDER BY o.created_at DESC
            LIMIT 10`,
            [from]
        );


        if (rows.length === 0) {
            sendProactiveMessage(from, `Você não possui nenhum pedido finalizado`);

            userFlows[from].status = '';
            return
        }

        // Gerar uma lista de pedidos com informações detalhadas
        const ordersList = rows.map(order => {
            // Formatar o status do pedido
            let statusMessage = 'Pedido finalizado';  // Já sabemos que é 'f', então a mensagem é fixa

            return `Pedido ID: ${order.id}\nStatus: ${statusMessage}\nTotal: R$${parseFloat(order.total).toFixed(2)}\nData: ${new Date(order.created_at).toLocaleDateString()}\nFarmácia: ${order.pharmacy_name}`;
        }).join('\n\n');

        // Enviar a lista de pedidos para o usuário
        sendWhatsAppMessage(phone_number_id, from, `Seus pedidos finalizados:\n\n${ordersList}`, res);
    } catch (error) {
        console.error('Erro ao buscar pedidos finalizados:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Houve um erro ao buscar seus pedidos finalizados. Tente novamente mais tarde.', res);
    }
};

// Inicia o fluxo de compra
const startBuyFlow = (phone_number_id, from, res) => {

    if (!userFlows[from]) {
        userFlows[from] = { status: 'awaiting_product', cart: [] };
    } else {
        userFlows[from].status = 'awaiting_product';
    }
    console.log(userFlows[from].status);
    sendWhatsAppMessage(phone_number_id, from, 'Por favor, informe o nome do produto que deseja comprar.', res);
};

// Continuação da compra
const continueShopping = (phone_number_id, from, res) => {
    userFlows[from].status = 'awaiting_product'; // Atualiza o status para aguardar um novo produto
    sendWhatsAppMessage(phone_number_id, from, 'Ótimo! Digite o nome de outro produto que deseja.', res);
};

// Solicita a localização do usuário
const askForLocation = (phone_number_id, from, res) => {

    userFlows[from].status = 'awaiting_location';  // Altera o status para aguardar a localização
    sendWhatsAppMessage(
        phone_number_id,
        from,
        'Por favor, envie sua localização para finalizar a compra.',
        res,
        null,
        true
    );
};

const processLocation = async (phone_number_id, from, location, res) => {
    if (!userFlows[from] || userFlows[from].status !== 'awaiting_location') {
        return;
    }

    // Extraindo latitude, longitude e endereço da localização recebida
    const latitude = location.latitude;
    const longitude = location.longitude;
    const address = location.name || `${latitude}, ${longitude}`;

    try {
        // Criação de um pedido com a localização do usuário
        const cart = userFlows[from].cart;
        const totalAmount = cart.reduce((sum, item) => sum + parseFloat(item.price), 0).toFixed(2);

        const orderResult = await createOrder(from, cart, totalAmount, location);

        if (orderResult.success) {
            console.log(`Pedido ${orderResult.orderId} criado com sucesso para o usuário ${from}.`);

            // // Criando a sessão de Checkout do Stripe
            // const session = await stripe.checkout.sessions.create({
            //     payment_method_types: ['card'],
            //     line_items: cart.map(item => ({
            //         price_data: {
            //             currency: 'brl',
            //             product_data: {
            //                 name: item.name,
            //             },
            //             unit_amount: parseFloat(item.price) * 100,
            //         },
            //         quantity: item.quantity || 1,
            //     })),
            //     mode: 'payment',
            //     success_url: 'https://www.seusite.com/sucesso?session_id={CHECKOUT_SESSION_ID}', // URL de sucesso
            //     cancel_url: 'https://www.seusite.com/cancelado',
            // });

            // // Enviar o link de pagamento para o cliente
            const paymentMessage = `Seu pedido foi criado com sucesso. Logo o notificaremos o progresso de seu pedido`;
            // sendWhatsAppMessage(phone_number_id, from, paymentMessage, res);

            sendWhatsAppMessage(phone_number_id, from, paymentMessage, res);


        } else {
            console.error('Erro ao criar o pedido:', orderResult.error);
            sendWhatsAppMessage(phone_number_id, from, 'Erro ao processar seu pedido. Tente novamente mais tarde.', res);
        }

        // Limpa o carrinho após a compra
        delete userFlows[from];

    } catch (error) {
        console.error('Erro ao processar a compra:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Houve um erro ao processar seu pedido. Tente novamente mais tarde.', res);
    }
};

// Adiciona produto ao carrinho com o pharmacyId
const addToCart = async (phone_number_id, from, selectedProductId, res) => {
    console.log(`Usuário ${from} tentou adicionar o produto ${selectedProductId} ao carrinho.`);
    const productId = selectedProductId.replace('product_', '');

    if (!userFlows[from]) {
        userFlows[from] = { status: 'awaiting_product', cart: [] };
    }

    try {
        const [rows] = await db.execute(
            `SELECT id, name, price, pharmacy FROM products WHERE id = ?`,
            [productId]
        );

        if (rows.length === 0) {
            console.log(`Produto não encontrado para o ID: ${productId}`);
            sendWhatsAppMessage(phone_number_id, from, 'Produto não encontrado.', res);
            return;
        }

        const product = rows[0];

        // Adiciona o produto ao carrinho do usuário, incluindo o pharmacyId
        userFlows[from].cart.push({
            id: product.id,
            name: product.name,
            price: product.price,
            pharmacyId: product.pharmacy
        });

        userFlows[from].status = 'cart'; // Atualiza o estado para 'cart'
        console.log(`Produto ${product.name} adicionado ao carrinho do usuário ${from}.`);

        sendWhatsAppMessage(phone_number_id, from, `Produto ${product.name} adicionado ao carrinho. Deseja continuar comprando ou finalizar a compra?`, res, [
            { id: 'buy', title: 'Continuar comprando' },
            { id: 'checkout', title: 'Finalizar compra' }
        ], false, 'Carrinho Atualizado');
    } catch (error) {
        console.error('Erro ao adicionar ao carrinho:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Erro ao adicionar o produto ao carrinho. Tente novamente.', res);
    }
};

// Exibe o carrinho
// const showCart = (phone_number_id, from, res) => {
//     const cart = userFlows[from]?.cart;

//     if (!cart || cart.length === 0) {
//         sendWhatsAppMessage(phone_number_id, from, 'Seu carrinho está vazio.', res);
//         return;
//     }

//     const cartSummary = cart.map((item, index) => `${index + 1}. ${item.name} - R$${parseFloat(item.price).toFixed(2)}`).join('\n');
//     const total = cart.reduce((sum, item) => sum + parseFloat(item.price), 0).toFixed(2);

//     sendWhatsAppMessage(phone_number_id, from, `Itens no seu carrinho:\n${cartSummary}\n\nTotal: R$${total}`, res, [
//         { id: 'buy', title: 'Continuar comprando' },
//         { id: 'confirm_purchase', title: 'Finalizar compra' }
//     ], false, 'Resumo do Carrinho');
// };

// Confirma a compra e cria os pedidos separados por farmácia
const confirmPurchase = async (phone_number_id, from, res) => {
    const cart = userFlows[from]?.cart;

    if (!cart || cart.length === 0) {
        sendWhatsAppMessage(phone_number_id, from, 'Seu carrinho está vazio.', res);
        return;
    }

    const total = cart.reduce((sum, item) => sum + parseFloat(item.price), 0).toFixed(2);
    const location = userFlows[from]?.location;  // Obter a localização do usuário

    // Confirmação do pedido
    sendWhatsAppMessage(phone_number_id, from, `Compra confirmada! Total: R$${total}. Obrigado por comprar conosco!`, res);

    try {
        // Criação do pedido no banco de dados com a localização
        const orderResult = await createOrder(from, cart, total, location);  // Passando a localização aqui também

        if (orderResult.success) {
            console.log(`Pedido ${orderResult.orderId} criado com sucesso para o usuário ${from}.`);

            // Envia uma mensagem para o usuário confirmando o pedido
            const message = 'A farmácia aceitou seu pedido e estamos preparando o envio. Em breve, você receberá mais detalhes!';
            sendWhatsAppMessage(phone_number_id, from, message, res);
        } else {
            console.error('Erro ao criar o pedido:', orderResult.error);
            sendWhatsAppMessage(phone_number_id, from, 'Houve um erro ao processar seu pedido. Tente novamente mais tarde.', res);
        }

        // Limpa o carrinho após a compra
        delete userFlows[from];

    } catch (error) {
        console.error('Erro ao processar a compra:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Houve um erro ao processar seu pedido. Tente novamente mais tarde.', res);
    }
};

// Processa a requisição de compra
const processBuyRequest = async (phone_number_id, from, productName, res) => {
    try {
        const [rows] = await db.execute(
            `SELECT p.id, p.name, p.price, f.deliveryFee
            FROM products p
            JOIN pharmacys f ON p.pharmacy = f.id
            WHERE p.name LIKE ?`,
            [`%${productName}%`]
        );

        if (rows.length === 0) {
            sendWhatsAppMessage(phone_number_id, from, `Nenhum produto encontrado com o nome "${productName}".`, res);
            return;
        }

        // Mapeando os produtos para incluir a taxa de entrega
        const listSections = [
            {
                title: 'Produtos Encontrados',
                rows: rows.map((product) => ({
                    id: `product_${product.id}`,
                    title: `${product.name} - R$${parseFloat(product.price).toFixed(2)}`,
                    description: `Taxa de Entrega: R$${parseFloat(product.deliveryFee).toFixed(2)}`
                }))
            }
        ];

        const listData = {
            headerText: 'Produtos Disponíveis',
            bodyText: `Aqui estão os produtos que correspondem ao termo "${productName}":`,
            buttonText: 'Ver Produtos',
            sections: listSections
        };

        // Log the message data to debug
        console.log('Sending list message data:', JSON.stringify(listData, null, 2));

        sendWhatsAppList(phone_number_id, from, listData, res);
    } catch (error) {
        console.error('Erro ao consultar o banco de dados:', error);
        sendWhatsAppMessage(phone_number_id, from, 'Houve um erro ao processar seu pedido. Tente novamente mais tarde.', res);
    }
};
