// ==UserScript==
// @name         Discord Auto Responder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Discord自动回复插件，可以自动发言和回复消息，使用deepseek生成内容
// @author       KingSmile
// @match        https://discord.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=discord.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @connect      api.deepseek.com
// ==/UserScript==

/*
作者信息：
推特：https://x.com/KingSmile88
微信：yufeng8138 
DC社区：https://discord.gg/gTQ3uhxCFs
*/

(function() {
    'use strict';

    // 配置项
    const config = {
        // 是否启用插件
        enabled: false,
        // 自动回复频率(百分比，0-100)
        replyFrequency: 30,
        // Deepseek API密钥
        deepseekApiKey: '',
        // Discord Token
        discordToken: '',
        // 回复延迟时间范围(毫秒)
        minDelay: 2000,
        maxDelay: 10000,
        // 需要监听的频道ID列表
        channelIdsToMonitor: [],
        // 忽略的用户ID列表
        ignoreUserIds: [],
        // 自动发言模板
        messageTemplates: [
            "{generated_content}",
            "嗯{generated_content}",
            "哈哈{generated_content}",
            "确实{generated_content}",
            "对{generated_content}",
            "有意思{generated_content}",
            "原来如此{generated_content}",
            "学到了{generated_content}",
            "这样啊{generated_content}",
            "明白了{generated_content}"
        ],
        // 频道冷却时间记录
        channelCooldowns: {},
        // 消息队列配置
        queueConfig: {
            // 每个频道的最大等待队列长度
            maxQueueLength: 10,
            // 队列满时的处理策略
            queueStrategy: 'process_latest'
        }
    };

    // 存储最近的消息历史，用于上下文理解
    let messageHistory = [];
    const MAX_HISTORY_LENGTH = 10;

    // 界面元素
    let uiContainer = null;

    // 消息队列管理器
    class MessageQueueManager {
        constructor() {
            this.queues = {};
            this.processing = {};
        }

        // 添加消息到队列
        addToQueue(channelId, message) {
            if (!this.queues[channelId]) {
                this.queues[channelId] = [];
            }

            // 检查队列长度
            if (this.queues[channelId].length >= config.queueConfig.maxQueueLength) {
                console.log(`频道 ${channelId} 的消息队列已满，保留最新消息`);
                
                // 保留最新的消息，移除最早的消息
                this.queues[channelId].shift();
            }

            // 添加新消息到队列
            this.queues[channelId].push(message);
            console.log(`消息已添加到频道 ${channelId} 的队列，当前队列长度: ${this.queues[channelId].length}`);

            // 如果没有正在处理的消息，开始处理
            if (!this.processing[channelId]) {
                this.processQueue(channelId);
            }

            return true;
        }

        // 处理消息队列
        async processQueue(channelId) {
            if (!this.queues[channelId] || this.queues[channelId].length === 0) {
                this.processing[channelId] = false;
                return;
            }

            this.processing[channelId] = true;

            try {
                const message = this.queues[channelId][0];
                
                // 检查频道冷却状态
                if (isChannelInCooldown(channelId)) {
                    const remainingCooldown = getChannelRemainingCooldown(channelId);
                    console.log(`频道 ${channelId} 在冷却中，等待 ${remainingCooldown}ms 后继续处理队列`);
                    
                    await new Promise(resolve => setTimeout(resolve, remainingCooldown + 1000));
                    return this.processQueue(channelId);
                }

                // 生成回复内容
                const context = prepareContextForAI(message.content);
                const generatedContent = await callDeepseekAPI(context);

                if (generatedContent) {
                    // 准备发送的消息（包含@）
                    const messageToSend = prepareMessageToSend(generatedContent, message.metadata);
                    
                    // 获取适当的延迟时间
                    const delay = getAppropriateDelay(channelId);
                    
                    // 延迟发送消息
                    const sendSuccess = await sendMessage(messageToSend, channelId);
                    
                    if (!sendSuccess) {
                        console.log(`发送消息失败，将在稍后重试`);
                        // 将失败的消息移到队列末尾重试
                        const failedMessage = this.queues[channelId].shift();
                        this.queues[channelId].push(failedMessage);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        return this.processQueue(channelId);
                    }
                }

                // 移除已处理的消息
                this.queues[channelId].shift();

                // 继续处理队列中的下一条消息
                if (this.queues[channelId].length > 0) {
                    // 添加一个小延迟，避免消息发送太快
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    this.processQueue(channelId);
                } else {
                    this.processing[channelId] = false;
                }

            } catch (error) {
                console.error(`处理频道 ${channelId} 的消息队列时出错:`, error);
                // 出错时将消息移到队列末尾重试
                const errorMessage = this.queues[channelId].shift();
                this.queues[channelId].push(errorMessage);
                await new Promise(resolve => setTimeout(resolve, 5000));
                this.processQueue(channelId);
            }
        }

        // 获取队列状态
        getQueueStatus(channelId) {
            return {
                queueLength: this.queues[channelId]?.length || 0,
                isProcessing: this.processing[channelId] || false,
                messages: this.queues[channelId] || []
            };
        }
    }

    // 创建消息队列管理器实例
    const messageQueueManager = new MessageQueueManager();

    // 初始化
    function init() {
        console.log("开始初始化Discord Auto Responder插件...");
        loadSettings();
        createUI();
        startMonitoring();
        console.log("Discord Auto Responder插件已加载，配置信息:", config);
    }

    // 加载设置
    function loadSettings() {
        const savedConfig = GM_getValue('autoResponderConfig');
        if (savedConfig) {
            Object.assign(config, JSON.parse(savedConfig));
        }
    }

    // 保存设置
    function saveSettings() {
        GM_setValue('autoResponderConfig', JSON.stringify(config));
    }

    // 创建用户界面
    function createUI() {
        // 等待Discord完全加载
        const checkForDiscord = setInterval(() => {
            if (document.querySelector('[class*="sidebar"]')) {
                clearInterval(checkForDiscord);
                injectUI();
            }
        }, 1000);
    }

    // 注入UI
    function injectUI() {
        // 创建控制面板容器
        uiContainer = document.createElement('div');
        uiContainer.className = 'auto-responder-panel';
        uiContainer.style.cssText = `
            position: fixed;
            top: 60px;
            right: 20px;
            width: 300px;
            background-color: #36393f;
            border-radius: 8px;
            box-shadow: 0 0 10px rgba(0,0,0,0.5);
            z-index: 9999;
            padding: 15px;
            color: #dcddde;
            font-family: 'Whitney', 'Helvetica Neue', Helvetica, Arial, sans-serif;
        `;

        // 创建面板标题
        const title = document.createElement('div');
        title.style.cssText = `
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;
        title.innerHTML = `
            <span>Discord 自动回复助手</span>
            <span class="minimize-btn" style="cursor:pointer;font-size:20px;">−</span>
        `;
        uiContainer.appendChild(title);

        // 创建控制元素
        const controls = document.createElement('div');
        controls.className = 'controls';
        controls.innerHTML = `
            <div style="margin-bottom:15px;">
                <label style="display:flex;justify-content:space-between;align-items:center;">
                    <span>启用自动回复:</span>
                    <input type="checkbox" id="auto-responder-enabled" ${config.enabled ? 'checked' : ''}>
                </label>
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;">回复频率: ${config.replyFrequency}%</label>
                <input type="range" id="reply-frequency" min="0" max="100" value="${config.replyFrequency}" style="width:100%;">
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;">Deepseek API密钥:</label>
                <input type="password" id="deepseek-api-key" value="${config.deepseekApiKey}" placeholder="输入Deepseek API密钥" style="width:100%;padding:5px;background:#202225;border:1px solid #4f545c;color:#dcddde;border-radius:4px;">
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;">Discord Token:</label>
                <input type="password" id="discord-token" value="${config.discordToken}" placeholder="输入Discord Token" style="width:100%;padding:5px;background:#202225;border:1px solid #4f545c;color:#dcddde;border-radius:4px;">
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;">监听的频道ID (用逗号分隔):</label>
                <input type="text" id="channel-ids" value="${config.channelIdsToMonitor.join(',')}" placeholder="例如: 12345,67890" style="width:100%;padding:5px;background:#202225;border:1px solid #4f545c;color:#dcddde;border-radius:4px;">
            </div>

            <div style="margin-bottom:15px;">
                <label style="display:block;margin-bottom:5px;">延迟回复时间 (ms):</label>
                <div style="display:flex;gap:5px;">
                    <input type="number" id="min-delay" value="${config.minDelay}" placeholder="最小延迟" style="width:50%;padding:5px;background:#202225;border:1px solid #4f545c;color:#dcddde;border-radius:4px;">
                    <input type="number" id="max-delay" value="${config.maxDelay}" placeholder="最大延迟" style="width:50%;padding:5px;background:#202225;border:1px solid #4f545c;color:#dcddde;border-radius:4px;">
                </div>
            </div>

            <button id="save-settings" style="width:100%;padding:8px 0;background:#5865f2;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;margin-bottom:15px;">保存设置</button>

            <div style="margin-bottom:15px;text-align:center;">
                <a href="https://discord.gg/gTQ3uhxCFs" target="_blank" style="
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 8px 0;
                    background: #2f3136;
                    color: #dcddde;
                    text-decoration: none;
                    border-radius: 4px;
                    border: 1px solid #4f545c;
                    transition: background-color 0.2s;
                    gap: 8px;
                ">
                    <svg width="20" height="20" viewBox="0 0 71 55" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1066 30.1693C30.1066 34.1136 27.28 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="#dcddde"/>
                    </svg>
                    加入Discord社区获取帮助
                </a>
            </div>

            <div id="status-message" style="margin-top:10px;font-size:12px;"></div>
        `;
        uiContainer.appendChild(controls);

        // 添加到页面
        document.body.appendChild(uiContainer);

        // 添加事件监听器
        document.getElementById('auto-responder-enabled').addEventListener('change', function() {
            config.enabled = this.checked;
        });

        document.getElementById('reply-frequency').addEventListener('input', function() {
            config.replyFrequency = parseInt(this.value);
            this.previousElementSibling.textContent = `回复频率: ${config.replyFrequency}%`;
        });

        document.getElementById('save-settings').addEventListener('click', saveUISettings);

        document.querySelector('.minimize-btn').addEventListener('click', function() {
            const controls = document.querySelector('.controls');
            if (controls.style.display === 'none') {
                controls.style.display = 'block';
                this.textContent = '−';
            } else {
                controls.style.display = 'none';
                this.textContent = '+';
            }
        });

        // 使控制面板可拖动
        makeDraggable(uiContainer, title);
    }

    // 使元素可拖动
    function makeDraggable(element, handle) {
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

        handle.style.cursor = 'move';
        handle.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            // 获取鼠标位置
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            // 鼠标移动时调用elementDrag
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            // 计算新位置
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            // 设置元素的新位置
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            // 停止移动
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    // 保存UI设置
    function saveUISettings() {
        config.deepseekApiKey = document.getElementById('deepseek-api-key').value;
        config.discordToken = document.getElementById('discord-token').value;
        config.channelIdsToMonitor = document.getElementById('channel-ids').value
            .split(',')
            .map(id => id.trim())
            .filter(id => id);
        config.minDelay = parseInt(document.getElementById('min-delay').value) || 2000;
        config.maxDelay = parseInt(document.getElementById('max-delay').value) || 10000;

        saveSettings();

        const statusMsg = document.getElementById('status-message');
        statusMsg.textContent = '设置已保存!';
        statusMsg.style.color = '#43b581';
        setTimeout(() => {
            statusMsg.textContent = '';
        }, 3000);
    }

    // 开始监控Discord消息
    function startMonitoring() {
        console.log("开始设置消息监控...");

        // 创建消息观察器
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) { // 元素节点
                            // 尝试多个可能的消息选择器
                            const selectors = [
                                '[class*="message-"]',
                                '[class*="messageContent"]',
                                '[class*="chatContent-"] > div',
                                '[id^="message-content-"]'
                            ];

                            for (const selector of selectors) {
                                const messageNodes = node.querySelectorAll(selector);
                                if (messageNodes.length > 0) {
                                    console.log(`找到消息元素 (${selector}):`, messageNodes.length);
                                    messageNodes.forEach(processNewMessage);
                                }
                            }
                        }
                    });
                }
            });
        });

        // 开始观察消息容器
        function observeMessages() {
            // 尝试多个可能的容器选择器
            const containerSelectors = [
                '[class*="messagesWrapper"]',
                '[class*="chatContent"]',
                '[class*="messagesList"]',
                '[class*="chat-"]'
            ];

            let found = false;
            for (const selector of containerSelectors) {
                const container = document.querySelector(selector);
                if (container) {
                    console.log(`找到消息容器 (${selector})`);
                    observer.observe(container, {
                        childList: true,
                        subtree: true
                    });
                    found = true;
                    break;
                }
            }

            if (!found) {
                console.log("未找到消息容器，1秒后重试...");
                setTimeout(observeMessages, 1000);
            }
        }

        // 确保Discord完全加载后再开始监控
        if (document.readyState === 'complete') {
            observeMessages();
        } else {
            window.addEventListener('load', observeMessages);
        }
    }

    // 存储已处理的消息ID
    const processedMessages = new Set();

    // 提取消息内容
    function extractMessageContent(messageNode) {
        try {
            // 尝试多种选择器来获取消息内容
            const selectors = [
                '[class*="messageContent"]',
                '[id^="message-content-"]',
                '[class*="markup"]',
                '[class*="contents"] div'
            ];

            let content = null;
            let isMentioned = false;

            // 检查是否被@
            const mentionSelectors = [
                '[class*="mention"]',
                '[class*="mentioned"]',
                '[class*="wrapper-"] [class*="mention"]',
                '[class*="contents"] [class*="mention"]'
            ];

            // 检查是否包含@提及
            for (const selector of mentionSelectors) {
                const mentionNode = messageNode.querySelector(selector) || messageNode.closest(selector);
                if (mentionNode) {
                    isMentioned = true;
                    break;
                }
            }

            // 获取消息内容
            for (const selector of selectors) {
                const contentNode = messageNode.querySelector(selector) || messageNode.closest(selector);
                if (contentNode && contentNode.textContent) {
                    content = contentNode.textContent.trim();
                    break;
                }
            }

            // 如果上面的方法都失败了，尝试直接获取内容
            if (!content && messageNode.textContent) {
                content = messageNode.textContent.trim();
            }

            if (content) {
                console.log('成功提取消息内容:', content, '是否被@:', isMentioned);
                return {
                    content: content,
                    isMentioned: isMentioned
                };
            }

            console.log('无法提取消息内容，节点内容:', messageNode.innerHTML);
            return null;
        } catch (e) {
            console.error('提取消息内容时出错:', e);
            return null;
        }
    }

    // 提取消息元数据
    function extractMessageMetadata(messageNode) {
        try {
            // 获取频道ID
            let channelId = null;
            // 从URL中提取
            const channelMatch = window.location.href.match(/channels\/\d+\/(\d+)/);
            if (channelMatch) {
                channelId = channelMatch[1];
            }

            // 获取用户名和用户ID
            let username = null;
            let userId = null;
            const authorElement = messageNode.querySelector('[class*="username"]') || 
                                messageNode.querySelector('[class*="author"]');
            
            if (authorElement) {
                username = authorElement.textContent.trim();
                // 尝试获取用户ID
                const userLink = authorElement.closest('a[href*="users"]');
                if (userLink) {
                    const userMatch = userLink.href.match(/users\/(\d+)/);
                    if (userMatch) {
                        userId = userMatch[1];
                    }
                }
            }

            // 获取消息ID
            let messageId = null;
            if (messageNode.id) {
                messageId = messageNode.id.replace('message-', '');
            } else {
                const idMatch = messageNode.querySelector('[id^="message-content-"]');
                if (idMatch) {
                    messageId = idMatch.id.replace('message-content-', '');
                }
            }

            const metadata = {
                username: username,
                userId: userId,
                channelId: channelId,
                messageId: messageId,
                timestamp: new Date()
            };

            console.log('提取的消息元数据:', metadata);
            return metadata;
        } catch (e) {
            console.error('提取消息元数据时出错:', e);
            return null;
        }
    }

    // 决定是否应该忽略此消息
    function shouldIgnoreMessage(metadata) {
        // 忽略自己的消息
        const selfUsername = document.querySelector('[class*="nameTag"] [class*="username"]')?.textContent;
        if (metadata.username === selfUsername) return true;

        // 检查是否在监控的频道列表中
        if (config.channelIdsToMonitor.length > 0 &&
            !config.channelIdsToMonitor.includes(metadata.channelId)) {
            return true;
        }

        // 检查是否在忽略的用户列表中
        if (metadata.userId && config.ignoreUserIds.includes(metadata.userId)) {
            return true;
        }

        return false;
    }

    // 添加到消息历史
    function addToMessageHistory(username, content) {
        messageHistory.push({ username, content, timestamp: new Date() });

        // 限制历史长度
        if (messageHistory.length > MAX_HISTORY_LENGTH) {
            messageHistory.shift();
        }
    }

    // 决定是否回复消息
    function shouldReplyToMessage() {
        // 根据设置的回复频率决定
        return Math.random() * 100 < config.replyFrequency;
    }

    // 调用Deepseek API
    function callDeepseekAPI(prompt) {
        return new Promise((resolve, reject) => {
            console.log('准备调用Deepseek API');
            console.log('API密钥状态:', config.deepseekApiKey ? '已设置' : '未设置');
            console.log('发送的prompt:', prompt);

            if (!config.deepseekApiKey) {
                console.error('未设置Deepseek API密钥');
                resolve(null);
                return;
            }

            const apiKey = config.deepseekApiKey.trim();
            console.log('API密钥长度:', apiKey.length);

            GM_xmlhttpRequest({
                method: "POST",
                url: "https://api.deepseek.com/v1/chat/completions",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                    "Origin": "https://discord.com",
                    "Referer": "https://discord.com/"
                },
                data: JSON.stringify({
                    model: "deepseek-chat",
                    messages: [
                        {
                            role: "system",
                            content: "你是一个友好的聊天助手，请用简短自然的语言回复。"
                        },
                        {
                            role: "user",
                            content: prompt
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 100,
                    top_p: 0.9
                }),
                onload: function(response) {
                    console.log('API响应状态:', response.status);
                    console.log('API响应头:', response.responseHeaders);
                    console.log('API原始响应:', response.responseText);

                    if (response.status === 401) {
                        console.error('API认证失败，请检查API密钥');
                        resolve(null);
                        return;
                    }

                    try {
                        const result = JSON.parse(response.responseText);
                        console.log('API解析后的结果:', result);

                        if (result.choices && result.choices[0] && result.choices[0].message) {
                            const content = result.choices[0].message.content.trim();
                            console.log('生成的回复内容:', content);
                            resolve(content);
                        } else {
                            console.error('API返回格式不正确:', result);
                            resolve(null);
                        }
                    } catch (e) {
                        console.error('处理API响应时出错:', e);
                        resolve(null);
                    }
                },
                onerror: function(error) {
                    console.error('API请求失败:', error);
                    resolve(null);
                }
            });
        });
    }

    // 准备AI的上下文
    function prepareContextForAI(triggerMessage) {
        // 将最近的消息历史和触发消息组合为上下文
        let context = "请根据以下聊天记录生成一个简短的回复。回复要像正常人的对话一样自然，不要加任何前缀，直接表达你的想法：\n\n";

        // 添加最近的历史消息（限制数量）
        const recentHistory = messageHistory.slice(-3);  // 只使用最近3条消息
        if (recentHistory.length > 0) {
            context += "最近的聊天记录:\n";
            recentHistory.forEach(msg => {
                context += `${msg.username}: ${msg.content}\n`;
            });
            context += "\n";
        }

        // 添加当前需要回复的消息
        context += `需要回复的消息: ${triggerMessage}\n\n`;
        context += "请直接生成回复，不要加任何前缀，长度不要超过50个字。";

        console.log('准备的AI上下文:', context);
        return context;
    }

    // 检测频道冷却时间
    function detectChannelCooldown() {
        try {
            // 查找Discord的冷却时间提示元素
            const cooldownElements = document.querySelectorAll('[class*="cooldownWrapper"], [class*="slowModeMessage"]');
            for (const element of cooldownElements) {
                if (element && element.textContent) {
                    // 提取冷却时间数字（秒）
                    const match = element.textContent.match(/(\d+)/);
                    if (match) {
                        return parseInt(match[1]) * 1000; // 转换为毫秒
                    }
                }
            }
            return 0;
        } catch (e) {
            console.error('检测频道冷却时间时出错:', e);
            return 0;
        }
    }

    // 更新频道冷却状态
    function updateChannelCooldown(channelId) {
        const cooldownTime = detectChannelCooldown();
        if (cooldownTime > 0) {
            config.channelCooldowns[channelId] = {
                endTime: Date.now() + cooldownTime,
                duration: cooldownTime
            };
            console.log(`更新频道 ${channelId} 的冷却时间: ${cooldownTime}ms`);
        }
    }

    // 检查频道是否在冷却中
    function isChannelInCooldown(channelId) {
        const cooldown = config.channelCooldowns[channelId];
        if (cooldown && Date.now() < cooldown.endTime) {
            return true;
        }
        return false;
    }

    // 获取频道剩余冷却时间
    function getChannelRemainingCooldown(channelId) {
        const cooldown = config.channelCooldowns[channelId];
        if (cooldown) {
            const remaining = cooldown.endTime - Date.now();
            return remaining > 0 ? remaining : 0;
        }
        return 0;
    }

    // 获取适当的延迟时间
    function getAppropriateDelay(channelId) {
        // 获取频道剩余冷却时间
        const cooldownRemaining = getChannelRemainingCooldown(channelId);
        
        // 获取配置的随机延迟时间
        const randomDelay = Math.floor(Math.random() * (config.maxDelay - config.minDelay + 1)) + config.minDelay;
        
        // 取较大值，确保延迟时间大于冷却时间
        const appropriateDelay = Math.max(cooldownRemaining + 1000, randomDelay);
        
        console.log(`频道 ${channelId} 的延迟时间计算:`, {
            cooldownRemaining,
            randomDelay,
            finalDelay: appropriateDelay
        });
        
        return appropriateDelay;
    }

    // 准备要发送的消息
    function prepareMessageToSend(generatedContent, metadata) {
        if (!metadata || !metadata.username) {
            return generatedContent;
        }

        // 如果原消息是@我们的，我们也用@回复
        if (metadata.isMentioned) {
            // 添加@用户的格式
            return `<@${metadata.userId}> ${generatedContent}`;
        }

        return generatedContent;
    }

    // 发送消息
    async function sendMessage(message, channelId) {
        try {
            // 发送前再次检查冷却状态
            if (isChannelInCooldown(channelId)) {
                const remainingCooldown = getChannelRemainingCooldown(channelId);
                console.log(`发送前检测到频道冷却，将等待 ${remainingCooldown}ms 后重试`);
                await new Promise(resolve => setTimeout(resolve, remainingCooldown + 1000));
                return sendMessage(message, channelId);
            }

            console.log('准备发送消息到频道:', channelId);
            console.log('消息内容:', message);

            if (!config.discordToken) {
                throw new Error('未设置Discord Token');
            }

            // 使用Discord API发送消息
            const response = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
                method: 'POST',
                headers: {
                    'Authorization': config.discordToken,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    content: message,
                    tts: false,
                    flags: 0
                })
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Discord API错误: ${response.status} - ${JSON.stringify(errorData)}`);
            }

            const result = await response.json();
            console.log('消息发送成功:', result);
            
            // 更新频道冷却状态
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                const resetAfter = response.headers.get('x-ratelimit-reset-after');
                if (resetAfter) {
                    const cooldownTime = Math.ceil(parseFloat(resetAfter) * 1000);
                    config.channelCooldowns[channelId] = {
                        endTime: Date.now() + cooldownTime,
                        duration: cooldownTime
                    };
                    console.log(`更新频道 ${channelId} 的冷却时间: ${cooldownTime}ms`);
                }
            }

            return true;
        } catch (e) {
            console.error('发送消息时出错:', e);
            
            // 如果是速率限制错误，更新冷却时间
            if (e.message.includes('429')) {
                try {
                    const errorData = JSON.parse(e.message.split('Discord API错误: 429 - ')[1]);
                    if (errorData.retry_after) {
                        const cooldownTime = Math.ceil(errorData.retry_after * 1000);
                        config.channelCooldowns[channelId] = {
                            endTime: Date.now() + cooldownTime,
                            duration: cooldownTime
                        };
                        console.log(`收到速率限制，更新频道 ${channelId} 的冷却时间: ${cooldownTime}ms`);
                    }
                } catch (parseError) {
                    console.error('解析速率限制信息失败:', parseError);
                }
            }
            
            return false;
        }
    }

    // 修改处理新消息的函数
    function processNewMessage(messageNode) {
        try {
            console.log("检测到新消息节点:", messageNode);

            if (!config.enabled) {
                console.log("插件未启用，跳过处理");
                return;
            }

            // 检查是否已经处理过这条消息
            const messageId = messageNode.id || messageNode.querySelector('[id^="message-content-"]')?.id;
            if (messageId && processedMessages.has(messageId)) {
                console.log("消息已处理过，跳过:", messageId);
                return;
            }

            // 提取消息内容
            const messageData = extractMessageContent(messageNode);
            if (!messageData) {
                console.log("无法提取消息内容，跳过处理");
                return;
            }

            // 提取元数据
            const metadata = extractMessageMetadata(messageNode);
            if (!metadata || !metadata.channelId) {
                console.log("无法获取频道ID，跳过处理");
                return;
            }

            // 检查是否应该忽略此消息
            if (shouldIgnoreMessage(metadata)) {
                console.log("根据规则忽略此消息:", metadata);
                return;
            }

            // 记录已处理的消息
            if (messageId) {
                processedMessages.add(messageId);
            }

            // 添加到消息历史
            addToMessageHistory(metadata.username || "未知用户", messageData.content);

            // 决定是否需要回复
            if (messageData.isMentioned || shouldReplyToMessage()) {
                // 将消息添加到队列
                const queueSuccess = messageQueueManager.addToQueue(metadata.channelId, {
                    content: messageData.content,
                    isMentioned: messageData.isMentioned,
                    metadata: metadata
                });

                if (!queueSuccess) {
                    console.log("消息队列已满，无法添加新消息");
                }
            }
        } catch (e) {
            console.error("处理消息时出错:", e);
        }
    }

    // 修改生成并发送回复函数
    async function generateAndSendReply(triggerMessage, channelId, metadata) {
        try {
            if (!config.deepseekApiKey) {
                console.error('未设置Deepseek API密钥，无法生成回复');
                return;
            }

            // 检查并更新频道冷却状态
            updateChannelCooldown(channelId);

            // 准备上下文
            const context = prepareContextForAI(triggerMessage);
            const generatedContent = await callDeepseekAPI(context);

            if (!generatedContent) {
                console.error('生成回复失败');
                return;
            }

            // 准备发送的消息（包含@）
            const messageToSend = prepareMessageToSend(generatedContent, metadata);
            
            // 获取适当的延迟时间
            const delay = getAppropriateDelay(channelId);
            
            // 延迟发送消息
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // 发送消息
            await sendMessage(messageToSend, channelId);

            return true;
        } catch (e) {
            console.error('生成回复过程中出错:', e);
            return false;
        }
    }

    // 等待页面加载完成后初始化插件
    window.addEventListener('load', function() {
        setTimeout(init, 3000); // 给Discord足够的时间加载
    });
})();