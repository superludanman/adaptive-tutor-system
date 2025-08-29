
// ==================== 导入模块 ====================
// 导入配置模块
import { AppConfig, buildBackendUrl, initializeConfig } from '../modules/config.js';
import { MiniKnowledgeGraph } from '../modules/mini_knowledge_graph.js';
import { setupHeaderTitle, setupBackButton, getUrlParam, trackReferrer,navigateTo } from '../modules/navigation.js';
// 导入功能模块
import { 
    renderTopicContent,
    setTopicData,
    getTopicData
} from '../modules/docs_module.js';

import {
    createSelectorBridge,
    initIframeSelector,
    handleStartSelector,
    stopSelector,
    initBridge,
    handleCumulativeToggle,
    handleShowSource,
    handleError
} from '../modules/iframe-selector.js';

// 导入行为追踪器
import tracker from '../modules/behavior_tracker.js';

// 导入聊天模块
import chatModule from '../modules/chat.js';

// 导入API客户端
import '../api_client.js';

console.log('learning_page.js 开始加载...');

// ==================== 变量定义 ====================
let bridge = null;
let allowedElements = {
    cumulative: [],
    current: []
};
let currentTopicId = '1_1'; // 默认主题ID

// 模块实例
let knowledgeModule = null;

// 统一的初始化状态管理
const AppState = {
    isInitialized: false,
    isDataLoaded: false,
    initPromise: null
};

const miniGraph = new MiniKnowledgeGraph('containerId', {
  height: 200,
  nodeSize: 20,
  chapterNodeSize: 30,
  fontSize: 10
});

// 应用数据存储，用于管理API数据
const AppDataStore = {
    // API数据缓存
    apiData: {
        topicContent: null,      // 主题内容数据
        allowedElements: null,   // 可选元素数据
        userProgress: null       // 用户进度数据
    },
    
    // 设置数据
    setData(key, data) {
        this.apiData[key] = data;
        console.log(`[AppDataStore] 设置数据 ${key}:`, data);
    },
    
    // 获取数据
    getData(key) {
        const data = this.apiData[key];
        console.log(`[AppDataStore] 获取数据 ${key}:`, data);
        return data;
    },
    
    // 检查数据是否已加载
    isDataLoaded(key) {
        return this.apiData[key] !== null;
    },
    
    // 清空数据
    clearData() {
        this.apiData = {
            topicContent: null,
            allowedElements: null,
            userProgress: null
        };
        console.log('[AppDataStore] 数据已清空');
    }
};

// ==================== 全局初始化 ====================
// iframe加载状态管理
let iframeLoadProcessed = false;

// 为行为追踪器设置participant_id（如果不存在则使用默认值）
if (!window.participantId) {
    window.participantId = 'user123'; // 默认用户ID，实际应用中应该从session获取
}

// 确保localStorage中有participant_id，供api_client.js使用
if (!localStorage.getItem('participant_id')) {
    localStorage.setItem('participant_id', 'user123');
}

// ==================== 主应用初始化 ====================
async function initMainApp() {
    // 防止重复初始化的检查
    if (AppState.isInitialized) {
        console.log('主应用已经初始化过，跳过重复初始化');
        return;
    }
    
    // 如果正在初始化，等待完成
    if (AppState.initPromise) {
        console.log('主应用正在初始化中，等待完成');
        return AppState.initPromise;
    }
    
    // 创建初始化Promise
    AppState.initPromise = (async () => {
        try {
            // 标记为已初始化（立即设置，防止重复执行）
            AppState.isInitialized = true;
            
            console.log('开始初始化主应用...');
            
            // 获取必要的DOM元素
            const { startButton, stopButton, iframe } = getRequiredDOMElements();
            if (!startButton || !stopButton || !iframe) {
                throw new Error('必要的DOM元素未找到');
            }
            
            // 初始化按钮状态
            startButton.disabled = true;
            
            // 获取topicId并更新页面标题
            const topicId = getTopicIdFromURL();
            updatePageTitle(topicId);
            
            try {
                // 加载所有数据
                await loadAllData(topicId);
                
                // 初始化各个模块
                await initializeModules(topicId);
                
                // 初始化UI事件
                initializeUIEvents(iframe);
                
                // 启用按钮
                startButton.disabled = false;
                
                console.log('主应用初始化完成');
                
            } catch (error) {
                console.error('数据加载失败，使用默认配置:', error);
                await handleInitializationFailure(topicId);
                startButton.disabled = false;
            }
            
        } catch (error) {
            console.error('主应用初始化失败:', error);
            // 重置初始化状态，允许重试
            AppState.isInitialized = false;
            AppState.initPromise = null;
            throw error;
        }
    })();
    
    return AppState.initPromise;
}

// 获取必要的DOM元素
function getRequiredDOMElements() {
    const startButton = document.getElementById('startSelector');
    const stopButton = document.getElementById('stopSelector');
    const iframe = document.getElementById('element-selector-iframe');
    
    return { startButton, stopButton, iframe };
}

// 从URL获取topicId
function getTopicIdFromURL() {
    const topicId = getUrlParam('topic') || '1_1'; // 使用默认值
    currentTopicId = topicId.id;
    return topicId.id;
}

// 更新页面标题
function updatePageTitle(topicId) {
    const headerTitle = document.querySelector('.header-title');
    if (headerTitle) {
        headerTitle.textContent = `学习 - ${topicId}`;
    }
}

// 加载所有数据
async function loadAllData(topicId) {
    console.log('[MainApp] 开始加载所有数据...');
    console.log('[MainApp] 当前topicId:', topicId);
    
    // 获取学习内容数据
    const topicContent = await fetchTopicContent(topicId);
    
    // 获取用户进度数据
    const userProgress = await fetchUserProgress();
    
    // 解析可选元素数据
    const elementsData = getAllowedElementsFromData(topicContent, topicId);
    
    // 存储所有数据
    AppDataStore.setData('topicContent', topicContent);
    AppDataStore.setData('userProgress', userProgress);
    AppDataStore.setData('allowedElements', elementsData);
    
    // 设置全局变量
    allowedElements = elementsData;
    
    console.log('[MainApp] 数据加载完成:', { 
        topicContent: topicContent.title,
        elementsCount: elementsData.current.length,
        progress: userProgress?.data?.completed_topics?.length || 0
    });
}

// 获取学习内容数据
async function fetchTopicContent(topicId) {
    const apiUrl = buildBackendUrl(`/learning-content/${topicId}`);
    console.log('[MainApp] 学习内容API请求地址:', apiUrl);
    
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    if (data.code !== 200 || !data.data) {
        throw new Error('学习内容API返回数据格式错误');
    }
    
    return data.data;
}

// 获取用户进度数据
async function fetchUserProgress() {
    // 从localStorage或session获取用户ID
    const userId = localStorage.getItem('participant_id') || 'user123';
    const progressUrl = buildBackendUrl(`/progress/participants/${userId}/progress`);
    console.log('[MainApp] 进度API请求地址:', progressUrl);
    
    try {
        const response = await fetch(progressUrl);
        const data = await response.json();
        return data;
    } catch (error) {
        console.warn('[MainApp] 获取用户进度失败:', error);
        return null;
    }
}

// 初始化各个模块
async function initializeModules(topicId) {
    // 初始化知识点模块
    knowledgeModule = new KnowledgeModule();
    console.log('[MainApp] 知识点模块初始化完成');

    // 初始化简化知识图谱
    try {
        const miniGraph = new MiniKnowledgeGraph('miniGraphContainer', {
        height: 200,
        nodeSize: 20,
        chapterNodeSize: 30,
        fontSize: 10
        });
        await miniGraph.init();
        console.log('[MainApp] 简化知识图谱初始化完成');
    } catch (error) {
        console.error('[MainApp] 简化知识图谱初始化失败:', error);
    }
    
    // 初始化聊天模块
    try {
        chatModule.init('learning', topicId);
        console.log('[MainApp] 聊天模块初始化完成');
    } catch (error) {
        console.error('[MainApp] 聊天模块初始化失败:', error);
    }
    
    // 更新页面标题为实际内容标题
    const topicContent = AppDataStore.getData('topicContent');
    if (topicContent?.title) {
        const headerTitle = document.querySelector('.header-title');
        if (headerTitle) {
            headerTitle.textContent = topicContent.title;
            console.log('页面标题已更新为:', topicContent.title);
        }
    }
    
    // 渲染知识点内容
    if (topicContent?.levels) {
        setTopicData(topicContent);
        renderTopicContent();
    }
}

// 初始化UI事件
function initializeUIEvents(iframe) {
    // 初始化iframe事件监听（只绑定一次）
    initIframeEvents(iframe);
    
    // 初始化所有事件监听器
    initEventListeners();
    
    // 初始化iframe选择器
    initIframeSelector();
}

// 处理初始化失败的情况
// async function handleInitializationFailure(topicId) {
//     console.log('[MainApp] 使用默认配置进行初始化...');
    
//     // 设置默认元素
//     allowedElements = {
//         cumulative: ['div', 'span', 'p', 'h1', 'h2', 'h3'],
//         current: ['div', 'span', 'p']
//     };
    
//     // 初始化知识点模块
//     knowledgeModule = new KnowledgeModule();
//     console.log('[MainApp] 知识点模块初始化完成（失败后）');
    
    // 初始化聊天模块 - 已注释
    // try {
    //     chatModule.init('learning', topicId);
    //     console.log('[MainApp] 聊天模块初始化完成（失败后）');
    // } catch (error) {
    //     console.error('[MainApp] 聊天模块初始化失败（失败后）:', error);
    // }
// }

// ==================== 功能模块 ====================

// 知识点管理模块
class KnowledgeModule {
    constructor(options = {}) {
        this.levelCards = [];
        this.knowledgePanel = null;
        this.options = {
            ...options
        };
        
        this.init();
    }
    
    // 初始化知识点模块
    init() {
        console.log('[KnowledgeModule] 开始初始化知识点模块');
        
        // 获取知识点面板和卡片元素
        this.knowledgePanel = document.querySelector('.knowledge-panel');
        this.levelCards = document.querySelectorAll('.level-card');
        
        console.log('[KnowledgeModule] 找到知识点面板:', this.knowledgePanel);
        console.log('[KnowledgeModule] 找到卡片数量:', this.levelCards.length);
        
        if (!this.knowledgePanel) {
            console.error('[KnowledgeModule] 知识点面板元素未找到');
            return;
        }
        
        if (this.levelCards.length === 0) {
            console.warn('[KnowledgeModule] 未找到知识点卡片');
            return;
        }
        
        // 绑定事件监听器
        this.bindEvents();
        
        // 绑定键盘事件
        this.bindKeyboardEvents();
        
        console.log('[KnowledgeModule] 知识点模块初始化完成');
    }
    
    // 绑定事件监听器
    bindEvents() {
        console.log('[KnowledgeModule] 开始绑定事件，找到卡片数量:', this.levelCards.length);
        
        this.levelCards.forEach((card, index) => {
            console.log(`[KnowledgeModule] 为卡片 ${index + 1} (level ${card.dataset.level}) 绑定点击事件`);
            
            card.addEventListener('click', (event) => {
                console.log(`[KnowledgeModule] 卡片 ${index + 1} 被点击了！`);
                event.preventDefault();
                event.stopPropagation();
                this.handleCardClick(card);
            });
        });
        
        console.log('[KnowledgeModule] 事件绑定完成');
    }
    
    // 绑定键盘事件
    bindKeyboardEvents() {
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                const isExpanded = this.knowledgePanel.classList.contains('expanded');
                if (isExpanded) {
                    console.log('[KnowledgeModule] 检测到ESC键，退出展开模式');
                    // 收起所有卡片
                    this.levelCards.forEach(card => {
                        card.classList.remove('expanded');
                        card.classList.add('collapsed');
                    });
                    // 收起知识点面板
                    this.knowledgePanel.classList.remove('expanded');
                }
            }
        });
    }
    
    // 处理卡片点击事件
    handleCardClick(clickedCard) {
        console.log('[KnowledgeModule] 处理卡片点击事件');
        console.log('[KnowledgeModule] 被点击的卡片:', clickedCard);
        console.log('[KnowledgeModule] 卡片当前类名:', clickedCard.className);
        console.log('[KnowledgeModule] 卡片等级:', clickedCard.dataset.level);
        
        const isExpanded = this.knowledgePanel.classList.contains('expanded');
        console.log('[KnowledgeModule] 知识点面板是否已展开:', isExpanded);
        
        if (!isExpanded) {
            // 进入单卡片展开模式
            console.log('[KnowledgeModule] 进入单卡片展开模式');
            
            // 先收起所有卡片
            this.levelCards.forEach(card => {
                card.classList.remove('expanded');
                card.classList.add('collapsed');
                console.log(`[KnowledgeModule] 收起卡片 ${card.dataset.level}:`, card.className);
            });
            
            // 展开被点击的卡片
            clickedCard.classList.remove('collapsed');
            clickedCard.classList.add('expanded');
            console.log(`[KnowledgeModule] 展开卡片 ${clickedCard.dataset.level}:`, clickedCard.className);
            
            // 展开整个知识点面板
            this.knowledgePanel.classList.add('expanded');
            console.log('[KnowledgeModule] 知识点面板类名:', this.knowledgePanel.className);
            
            console.log('[KnowledgeModule] 单卡片展开模式已激活');
        } else {
            // 退出单卡片展开模式
            console.log('[KnowledgeModule] 退出单卡片展开模式');
            
            // 收起所有卡片
            this.levelCards.forEach(card => {
                card.classList.remove('expanded');
                card.classList.add('collapsed');
                console.log(`[KnowledgeModule] 收起卡片 ${card.dataset.level}:`, card.className);
            });
            
            // 收起知识点面板
            this.knowledgePanel.classList.remove('expanded');
            console.log('[KnowledgeModule] 知识点面板类名:', this.knowledgePanel.className);
            
            console.log('[KnowledgeModule] 已退出单卡片展开模式，返回选择界面');
        }
    }
    
    // 展开指定等级的卡片
    expandLevel(level) {
        const targetCard = document.querySelector(`.level-card[data-level="${level}"]`);
        if (targetCard) {
            this.handleCardClick(targetCard);
        }
    }
    
    // 收起所有卡片
    collapseAll() {
        this.levelCards.forEach(card => {
            card.classList.remove('expanded');
            card.classList.add('collapsed');
        });
        
        if (this.knowledgePanel) {
            this.knowledgePanel.classList.remove('expanded');
        }
    }
}

// ==================== 事件处理函数 ====================

// iframe事件初始化
function initIframeEvents(iframe) {
    // 只绑定一次
    if (iframe.hasAttribute('data-load-event-bound')) {
        return;
    }
    
    iframe.setAttribute('data-load-event-bound', 'true');
    
    iframe.addEventListener('load', function () {
        // 防止重复处理iframe加载事件
        if (iframeLoadProcessed) {
            console.log('iframe加载事件已处理过，跳过重复处理');
            return;
        }
        
        // 标记为已处理（立即设置，防止重复执行）
        iframeLoadProcessed = true;
        
        console.log('预览框架已加载:', iframe.src);
        showStatus('info', '预览页面已加载，选择器已就绪');
        
        // 初始化桥接
        setTimeout(() => {
            bridge = initBridge(createSelectorBridge, 
                createElementSelectedWithTracking(), 
                (error) => handleError(error, showStatus, () => stopSelector(bridge))
            );
            // 初始化行为追踪器
            initBehaviorTracker();
        }, 100);
    });
    
    // 检查iframe是否已经加载完成
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
        iframeLoadProcessed = true;
        setTimeout(() => {
            bridge = initBridge(createSelectorBridge, 
                createElementSelectedWithTracking(), 
                (error) => handleError(error, showStatus, () => stopSelector(bridge))
            );
            // 初始化行为追踪器
            initBehaviorTracker();
        }, 100);
    }
}

// 事件监听器初始化
function initEventListeners() {
    const startButton = document.getElementById('startSelector');
    const stopButton = document.getElementById('stopSelector');
    const cumulativeToggle = document.getElementById('cumulativeToggle');
    const showSourceBtn = document.getElementById('showSourceBtn');
    const tabKnowledge = document.getElementById('tab-knowledge');
    const tabCode = document.getElementById('tab-code');
    const knowledgeContent = document.getElementById('knowledge-content');
    const codeContent = document.getElementById('code-content');

    // 启动选择器
    if (startButton) {
        startButton.addEventListener('click', () => {
            handleStartSelector(allowedElements, bridge, showStatus);
            // 切换按钮状态
            if (startButton && stopButton) {
                startButton.style.display = 'none';
                stopButton.style.display = 'inline-block';
            }
        });
    }

    // 停止选择器
    if (stopButton) {
        stopButton.addEventListener('click', () => {
            stopSelector(bridge);
            // 切换按钮状态
            if (startButton && stopButton) {
                startButton.style.display = 'inline-block';
                stopButton.style.display = 'none';
            }
        });
    }
    
    // 初始化开关事件监听器
    if (cumulativeToggle) {
        cumulativeToggle.addEventListener('change', () => handleCumulativeToggle(allowedElements, showStatus));
    }

    // Tab切换
    if (tabKnowledge && tabCode) {
        tabKnowledge.addEventListener('click', () => {
            if (knowledgeContent) knowledgeContent.style.display = '';
            if (codeContent) codeContent.style.display = 'none';
            tabKnowledge.classList.add('active');
            tabCode.classList.remove('active');
        });

        tabCode.addEventListener('click', () => {
            if (knowledgeContent) knowledgeContent.style.display = 'none';
            if (codeContent) codeContent.style.display = '';
            tabCode.classList.add('active');
            tabKnowledge.classList.remove('active');
        });
    }

    // 返回源代码按钮
    if (showSourceBtn) {
        showSourceBtn.addEventListener('click', handleShowSource);
    }

    // 开始测试按钮
    const startTestButton = document.getElementById('start-test-button');
    if (startTestButton) {
        startTestButton.addEventListener('click', () => {
            // 获取当前主题ID
            const topicId = getTopicIdFromURL();
            // 跳转到测试页面并传递topicId参数
            const testPageUrl = `../pages/test_page.html?topic=${topicId}`;
            console.log('[MainApp] 跳转到测试页面:', testPageUrl);
            navigateTo('/pages/test_page.html', topicId, true, true);
        });
    }
}

// 行为追踪器初始化
function initBehaviorTracker() {
    try {
        console.log('[MainApp] 开始初始化行为追踪器...');
        
        // 初始化元素选择器行为追踪
        tracker.initDOMSelector('startSelector', 'stopSelector', 'element-selector-iframe');
        
        // 初始化AI聊天行为追踪
        tracker.initChat('send-message', '#user-message', 'learning', currentTopicId);
        
        // 初始化闲置和焦点检测
        tracker.initIdleAndFocus();
        
        console.log('[MainApp] 行为追踪器初始化完成');
    } catch (error) {
        console.error('[MainApp] 行为追踪器初始化失败:', error);
    }
}

// 创建带行为追踪的元素选择处理函数
function createElementSelectedWithTracking() {
    return function(elementInfo, showStatus) {
        // 不再显示选中的元素信息
        // const statusMessage = `已选择: ${elementInfo.tagName}${elementInfo.id ? '#' + elementInfo.id : ''}${elementInfo.className ? '.' + elementInfo.className.split(' ')[0] : ''}`;
        // if (showStatus && typeof showStatus === 'function') {
        //     showStatus('success', statusMessage);
        // }
        
        // 自动切换按钮状态
        const startButton = document.getElementById('startSelector');
        const stopButton = document.getElementById('stopSelector');
        if (startButton && stopButton) {
            startButton.style.display = 'inline-block';
            stopButton.style.display = 'none';
        }
        
        // 获取选中元素的源代码并显示到代码面板
        displaySelectedElementCode(elementInfo);
        
        // 自动切换到代码标签页
        switchToCodeTab();
        
        // 记录到行为追踪器
        try {
            tracker.logEvent('dom_element_select', {
                tagName: elementInfo.tagName,
                selector: elementInfo.selector,
                id: elementInfo.id,
                className: elementInfo.className,
                position: elementInfo.bounds,
                topicId: currentTopicId
            });
        } catch (error) {
            console.warn('[MainApp] 行为追踪记录失败:', error);
        }
    };
}

// ==================== 数据处理函数 ====================

// 从API数据中提取可选元素
function getAllowedElementsFromData(data, topicId) {
    console.log(`[MainApp] 开始解析数据，目标章节: ${topicId}`);
    console.log(`[MainApp] 数据中是否包含 sc_all:`, !!data.sc_all);
    console.log(`[MainApp] 数据中是否包含 allowedElements:`, !!data.allowedElements);
    
    if (data.sc_all && Array.isArray(data.sc_all)) {
        console.log(`[MainApp] 找到 sc_all 数组，长度: ${data.sc_all.length}`);
        console.log(`[MainApp] sc_all 内容:`, data.sc_all);
        
        const cumulativeElements = getCumulativeAllowedElements(data.sc_all, topicId);
        const currentElements = getCurrentChapterElements(data.sc_all, topicId);
        
        console.log(`[MainApp] 累积元素:`, cumulativeElements);
        console.log(`[MainApp] 当前章节元素:`, currentElements);
        
        return {
            cumulative: cumulativeElements,
            current: currentElements
        };
    }
    
    // 如果直接包含 allowedElements
    if (data.allowedElements) {
        console.log(`[MainApp] 使用直接包含的 allowedElements:`, data.allowedElements);
        return {
            cumulative: data.allowedElements,
            current: data.allowedElements
        };
    }
    
    console.warn(`[MainApp] 未找到有效的元素数据，返回空数组`);
    return {
        cumulative: [],
        current: []
    };
}

// 获取累积的可选元素
function getCumulativeAllowedElements(scAll, targetTopicId) {
    const allowedElements = new Set();
    
    // 遍历所有章节
    for (const chapter of scAll) {
        const chapterTopicId = chapter.topic_id;
        const selectElements = chapter.select_element || [];
        
        // 将当前章节的可选元素添加到集合中
        selectElements.forEach(element => allowedElements.add(element));
        
        // 如果找到目标章节，停止累加
        if (chapterTopicId === targetTopicId) {
            break;
        }
    }
    
    return Array.from(allowedElements);
}

// 获取当前章节的元素
function getCurrentChapterElements(scAll, targetTopicId) {
    // 找到当前章节
    const currentChapter = scAll.find(chapter => chapter.topic_id === targetTopicId);
    
    if (currentChapter && currentChapter.select_element) {
        return currentChapter.select_element;
    }
    
    return [];
}

// 显示选中元素的源代码
function displaySelectedElementCode(elementInfo) {
    const codeContent = document.getElementById('code-content');
    
    if (!codeContent) {
        console.warn('无法获取代码面板');
        return;
    }
    
    try {
        // 直接使用elementInfo中的outerHTML，这是从iframe中获取的真实HTML代码
        let elementHTML = elementInfo.outerHTML || '';
        
        // 如果没有outerHTML，尝试使用其他方式
        if (!elementHTML) {
            // 构建基本的HTML结构
            elementHTML = `<${elementInfo.tagName}`;
            
            // 添加ID
            if (elementInfo.id) {
                elementHTML += ` id="${elementInfo.id}"`;
            }
            
            // 添加类名
            if (elementInfo.className) {
                elementHTML += ` class="${elementInfo.className}"`;
            }
            
            // 添加文本内容
            if (elementInfo.textContent) {
                elementHTML += `>${elementInfo.textContent}</${elementInfo.tagName}>`;
            } else {
                elementHTML += `></${elementInfo.tagName}>`;
            }
        }
        
        // 格式化HTML代码
        const formattedHTML = formatHTML(elementHTML);
        
        // 显示到代码面板
        codeContent.innerHTML = `
            <div class="code-header">
                <h4>选中的元素代码</h4>
                <div class="element-info">
                    <span class="tag-name">${elementInfo.tagName}</span>
                    ${elementInfo.id ? `<span class="element-id">#${elementInfo.id}</span>` : ''}
                    ${elementInfo.className ? `<span class="element-class">.${elementInfo.className.split(' ')[0]}</span>` : ''}
                </div>
            </div>
            <pre class="code-block"><code class="language-html">${formattedHTML}</code></pre>
        `;
        
        console.log('元素代码已显示到代码面板:', formattedHTML);
        
    } catch (error) {
        console.error('显示元素代码时出错:', error);
        codeContent.innerHTML = `
            <div class="code-header">
                <h4>错误</h4>
            </div>
            <pre class="code-block"><code class="language-text">无法获取元素代码: ${error.message}</code></pre>
        `;
    }
}

// 切换到代码标签页
function switchToCodeTab() {
    const tabKnowledge = document.getElementById('tab-knowledge');
    const tabCode = document.getElementById('tab-code');
    const knowledgeContent = document.getElementById('knowledge-content');
    const codeContent = document.getElementById('code-content');
    
    if (tabKnowledge && tabCode && knowledgeContent && codeContent) {
        // 隐藏知识点内容，显示代码内容
        knowledgeContent.style.display = 'none';
        codeContent.style.display = '';
        
        // 更新标签页状态
        tabKnowledge.classList.remove('active');
        tabCode.classList.add('active');
        
        console.log('已自动切换到代码标签页');
    }
}

// 格式化HTML代码
function formatHTML(html) {
    if (!html) return '';
    
    // 转义HTML特殊字符，防止XSS
    const escapeHtml = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    // 简单的HTML格式化
    let formatted = html
        .replace(/></g, '>\n<')  // 在标签之间添加换行
        .replace(/\n\s*\n/g, '\n')  // 移除多余的空行
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
    
    // 转义HTML内容
    return escapeHtml(formatted);
}

// ==================== 工具函数 ====================

// 显示状态信息
function showStatus(type, message) {
    const statusBadge = document.getElementById('statusBadge');
    if (statusBadge) {
        statusBadge.textContent = message;
        statusBadge.className = `status-badge status-${type}`;
        statusBadge.style.display = 'inline-block';
        
        setTimeout(() => {
            statusBadge.style.display = 'none';
        }, 3000);
    }
}

// ==================== 自动初始化 ====================
// 页面加载完成后自动初始化主应用
document.addEventListener('DOMContentLoaded', async () => {
    try {
        trackReferrer();
        // 设置标题点击跳转到知识图谱页面
        setupHeaderTitle('/pages/knowledge_graph.html');
        // 设置返回按钮（固定返回知识图谱）
        setupBackButton();
        // 先初始化配置
        console.log('[MainApp] 开始初始化配置...');
        await initializeConfig();
        console.log('[MainApp] 配置初始化完成:', AppConfig);
        
        // 然后初始化主应用
        initMainApp();
    } catch (error) {
        console.error('[MainApp] 配置初始化失败:', error);
        // 即使配置失败，也尝试初始化主应用
        initMainApp();
    }
}); 