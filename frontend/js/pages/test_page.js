// 导入模块
import { getParticipantId } from '../modules/session.js';
import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";
import { setupHeaderTitle, setupBackButton, getUrlParam, debugUrlParams, getReturnUrl  } from '../modules/navigation.js';
import tracker from '../modules/behavior_tracker.js';
import chatModule from '../modules/chat.js';
import websocket from '../modules/websocket_client.js';

// 初始化函数
async function initializePage() {
    const participantId = getParticipantId();
    if (participantId) {
        const participantElement = document.getElementById('participant_id');
        if (participantElement) {
            participantElement.textContent = participantId;
        }
    }
    // 获取并解密URL参数
     // 获取URL参数（带错误处理）
        const topicData = getUrlParam('topic');
        
        if (topicData && topicData.id) {
            console.log('测试主题ID:', topicData.id, '有效期:', topicData.isValid ? '有效' : '已过期');
                
            // 更新页面标题
            document.getElementById('headerTitle').textContent = `测试 - ${topicData.id}`;
            
            // 即使过期也继续加载内容，但提示用户
            if (!topicData.isValid) {
               console.warn('参数已过期，但仍继续加载内容');
            }
                
            // 加载对应的测试内容
            chatModule.init('test', topicData.id);
        } else {
            console.warn('未找到有效的主题参数，使用默认内容');
            console.log('加载默认测试内容');
        }
    
    let topicId = topicData.id;
    
    // 如果没有topic参数，且查询字符串只有一个值，则使用该值
    if (!topicId) {
        // 获取所有参数的键
        const keys = Array.from(urlParams.keys());
        // 如果没有键（如?1_1），则使用整个查询字符串
        if (keys.length === 0 && window.location.search.length > 1) {
            topicId = window.location.search.substring(1); // 去掉开头的'?'
        }
        // 如果有键但键为空字符串（这种情况较少见），则使用第一个值
        else if (keys.length === 1 && keys[0] === '') {
            topicId = urlParams.get('');
        }
    }
    
    if (!topicId) {
        console.error('未找到Topic ID');
        alert('错误：无效的测试链接。');
        return;
    }

    try {
        // 使用不带认证的get方法获取测试任务数据
        const response = await window.apiClient.getWithoutAuth(`/test-tasks/${topicId}`);
        if (response.code === 200 && response.data) {
            const task = response.data;
            // 更新UI
            updateUIWithTaskData(task);
            // 初始化编辑器
            initializeEditors(task.start_code);
 
        } else {
            throw new Error(response.message || '获取测试任务失败');
        }
    } catch (error) {
        console.error('初始化页面时出错:', error);
        alert('无法加载测试任务: ' + (error.message || '未知错误'));
    }

    try{
        websocket.connect();
        console.log('[MainApp] WebSocket模块初始化完成');
    }
    catch(error){
        console.error('[MainApp] WebSocket模块初始化失败:', error);
    }
}

// 更新UI
function updateUIWithTaskData(task) {
    const headerTitle = document.querySelector('.header-title');
    const requirementsContent = document.getElementById('test-requirements-content');
    if (headerTitle) {
        headerTitle.textContent = task.title || '编程测试';
    }
    if (requirementsContent) {
        requirementsContent.innerHTML = marked(task.description_md || '');
    }
}

// 初始化Monaco编辑器并设置实时预览
function initializeEditors(startCode) {
    // 设置初始代码
    if (typeof window.setInitialCode === 'function') {
        window.setInitialCode(startCode);
    }
    
    // 延迟初始化编辑器，确保editor.js中的require已经执行
    setTimeout(() => {
        if (window.monaco && window.editorState) {
            // 更新已经创建的编辑器实例的内容
            if (window.editorState.htmlEditor && window.editorState.htmlEditor.setValue) {
                window.editorState.htmlEditor.setValue(window.editorState.html);
            }
            if (window.editorState.cssEditor && window.editorState.cssEditor.setValue) {
                window.editorState.cssEditor.setValue(window.editorState.css);
            }
            if (window.editorState.jsEditor && window.editorState.jsEditor.setValue) {
                window.editorState.jsEditor.setValue(window.editorState.js);
            }
            
            // 触发预览更新
            if (typeof updateLocalPreview === 'function') {
                updateLocalPreview();
            }
        } else {
            console.error("Monaco Editor 或 editorState 未正确初始化。");
        }
    }, 100);
}


// 提交逻辑
function setupSubmitLogic() {
    const submitButton = document.getElementById('submit-button');
    if (!submitButton) return;
    
    submitButton.addEventListener('click', async () => {
        const originalText = submitButton.textContent;
        submitButton.disabled = true;
        submitButton.textContent = '批改中...';
        
        try {
            
            const topicData = getUrlParam('topic');
            const topicId = topicData && topicData.id ? topicData.id : null;
           
            if (!topicId) throw new Error("主题ID无效。");
            console.log('提交测试，主题ID:', topicId);
            const submissionData = {
                topic_id: topicId,
                code: {
                    html: window.editorState.htmlEditor?.getValue() || '',
                    css: window.editorState.cssEditor?.getValue() || '',
                    js: window.editorState.jsEditor?.getValue() || ''
                }
            };
            
            await window.apiClient.post('/submission/submit-test2', submissionData);
            websocket.subscribe("submission_result", (msg) => {
            console.log("[SubmitModule] 收到最终结果:", msg);
                    displayTestResult(msg);
                    if(msg.passed) {
                        alert("测试完成！即将跳转回到知识图谱界面");
                        setTimeout(() => { window.location.href = '/pages/knowledge_graph.html'; }, 3000);
                    } else {
                         alert("测试未通过，请查看详细结果并继续改进代码。");
                    }
        
             });


            // if (result.code === 200) {
            //     displayTestResult(result.data);
            //     if (result.data.passed) {
            //         alert("测试完成！即将跳转回到知识图谱界面");
            //         setTimeout(() => { window.location.href = '/pages/knowledge_graph.html'; }, 3000);
            //     } else {
            //         // TODO: 可以考虑直接在这里主动触发AI
            //         // 测试未通过，给用户一些鼓励和建议
            //         alert("测试未通过，请查看详细结果并继续改进代码。");
            //     }
            // } else {
            //     throw new Error(result.message || '提交失败');
            // }
        } catch (error) {
            console.error('提交测试时出错:', error);
            alert('提交测试时出错: ' + (error.message || '未知错误'));
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = originalText;
        }
    });
}

// 显示测试结果
function displayTestResult(result) {
    const testResultsContent = document.getElementById('test-results-content');
    if (!testResultsContent) {
        console.warn("未找到 'test-results-content' 元素。");
        const message = `${result.passed ? '✅ 通过' : '❌ 失败'}: ${result.message}\n\n详情:\n${(result.details || []).join('\n')}`;
        alert(message);
        return;
    }
    
    let content = `<h4>${result.passed ? '✅ 恭喜！通过测试！' : '❌ 未通过测试'}</h4><p>${result.message || ''}</p>`;
    if (result.details && result.details.length > 0) {
        content += `<h5>详细信息:</h5><ul>${result.details.map(d => `<li>${d}</li>`).join('')}</ul>`;
    }
    
    testResultsContent.innerHTML = content;
    testResultsContent.className = result.passed ? 'test-result-passed' : 'test-result-failed';
}

// 主程序入口
document.addEventListener('DOMContentLoaded', function() {
    // 设置标题和返回按钮
    setupHeaderTitle('/pages/knowledge_graph.html');
    // 设置返回按钮
    setupBackButton();
    // 调试信息
    debugUrlParams();
    require(['vs/editor/editor.main'], function () {
        initializePage();
        setupSubmitLogic();
        
        // 初始化AI聊天功能
        // 获取并解密URL参数
        const returnUrl = getReturnUrl();
        console.log('返回URL:', returnUrl);
        const contentId = getUrlParam('topic');
        if (contentId&& contentId.id) {
            // 使用新的聊天模块初始化
            chatModule.init('test', contentId);
        }
    });
});
