const axios = require('axios');
const bcrypt = require('bcryptjs');
const { ACCESS_TOKEN } = require('../config/config');
const userFlows = require('../state/userFlows');

const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// Função reutilizável para enviar mensagens
const sendWhatsAppMessage = (phone_number_id, to, text, res, buttons = null) => {
    const messageData = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: buttons ? 'interactive' : 'text',
        ...(buttons ? {
            interactive: {
                type: 'button',
                header: { type: 'text', text: 'Bem Vindo' },
                body: { text },
                action: { buttons: buttons.map(button => ({ type: 'reply', reply: button })) }
            }
        } : {
            text: { body: text }
        })
    };

    axios.post(`https://graph.facebook.com/v19.0/${phone_number_id}/messages?access_token=${ACCESS_TOKEN}`, messageData)
        .then(() => res.sendStatus(200))
        .catch(error => {
            console.error('Error sending message:', error);
            res.sendStatus(500);
        });
};

// Inicia o fluxo de registro
const startRegisterFlow = (phone_number_id, from, res) => {
    userFlows[from] = { step: 'password', data: { phoneNumber: from } }; // Armazena o número do usuário
    sendWhatsAppMessage(phone_number_id, from, 'Para começar seu registro, defina uma Senha:', res);
};

// Gerencia o fluxo de registro
const handleRegistrationStep = (phone_number_id, from, userText, res) => {
    const currentStep = userFlows[from]?.step;

    if (!currentStep) return sendWhatsAppMessage(phone_number_id, from, 'Não entendi, por favor, tente novamente.', res);

    switch (currentStep) {
        case 'password':
            // Hash the password
            const hashedPassword = bcrypt.hashSync(userText, 10);
            userFlows[from].data.password = hashedPassword;
            userFlows[from].step = 'confirmPassword';
            sendWhatsAppMessage(phone_number_id, from, 'Por favor, confirme sua senha:', res);
            break;

        case 'confirmPassword':
            // Compare the password hash with the input
            const isPasswordMatch = bcrypt.compareSync(userText, userFlows[from].data.password);
            if (isPasswordMatch) {
                userFlows[from].step = 'email';
                sendWhatsAppMessage(phone_number_id, from, 'Agora, por favor, informe seu e-mail:', res);
            } else {
                userFlows[from].step = 'password';
                sendWhatsAppMessage(phone_number_id, from, 'As senhas não coincidem. Vamos começar de novo.', res);
            }
            break;

        case 'email':
            if (validateEmail(userText)) {
                userFlows[from].data.email = userText;
                const { phoneNumber, password, email } = userFlows[from].data;
                saveUserToDatabase(from, { phoneNumber, password, email });
                sendWhatsAppMessage(phone_number_id, from, 'Parabéns! Seu registro foi concluído com sucesso.', res);
                delete userFlows[from];
            } else {
                sendWhatsAppMessage(phone_number_id, from, 'O e-mail fornecido não é válido. Por favor, tente novamente.', res);
            }
            break;
    }
};

// Função para salvar o usuário no banco de dados
const saveUserToDatabase = (from, userData) => {
    console.log('Salvando no banco de dados:', { from, ...userData });
    // Aqui você incluiria a lógica para salvar no banco, como uma inserção no MongoDB, MySQL, etc.
};

module.exports = { sendWhatsAppMessage, startRegisterFlow, handleRegistrationStep, saveUserToDatabase };
