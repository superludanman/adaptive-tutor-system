from pydantic import BaseModel, Field
from typing import Dict, Any,Literal, Optional, Union, Literal
from datetime import datetime
from enum import Enum

# TODO: 这里的类型可能不对，等恩琪的模块完成之后，需要再改
class EventType(str, Enum):
    """行为事件类型枚举
    
    根据TDD-II-07文档定义，对应前端behavior_tracker.js捕获的所有事件类型
    以及后端生成的事件类型（如state_snapshot）
    """
    CODE_EDIT = "code_edit"
    AI_HELP_REQUEST = "ai_help_request"
    TEST_SUBMISSION = "test_submission"
    DOM_ELEMENT_SELECT = "dom_element_select"
    USER_IDLE = "user_idle"
    PAGE_FOCUS_CHANGE = "page_focus_change"
    STATE_SNAPSHOT = "state_snapshot"
    PAGE_CLICK="page_click"


class CodeEditData(BaseModel):
    """代码编辑事件数据
    
    Attributes:
        editor_name: 编辑器名称，如 'html', 'css', 'js'
        new_length: 新的代码长度
    """
    editor_name: str = Field(..., description="编辑器名称")
    new_length: int = Field(..., ge=0, description="新的代码长度")


class AiHelpRequestData(BaseModel):
    """AI帮助请求数据
    
    Attributes:
        message: 用户向AI提问的消息内容
    """
    message: str = Field(..., min_length=1, description="用户向AI提问的消息内容")


class SubmissionData(BaseModel):
    """测试提交数据
    
    Attributes:
        topic_id: 知识点ID
        code: 用户提交的代码内容
    """
    topic_id: str = Field(..., description="知识点ID")
    code: Dict[str, str] = Field(..., description="用户提交的代码内容，包含html、css、js")


class DomElementSelectData(BaseModel):
    """DOM元素选择数据
    
    Attributes:
        tag_name: 选择的DOM元素标签名
        selector: DOM元素选择器
    """
    tag_name: str = Field(..., description="选择的DOM元素标签名")
    selector: str = Field(..., description="DOM元素选择器")


class UserIdleData(BaseModel):
    """用户闲置数据
    
    Attributes:
        duration_ms: 闲置时长（毫秒）
    """
    duration_ms: int = Field(..., gt=0, description="闲置时长（毫秒）")


class PageFocusChangeData(BaseModel):
    """页面焦点变化数据
    
    Attributes:
        status: 焦点状态，'focus' 或 'blur'
    """
    status: Literal["focus", "blur"] = Field(..., description="焦点状态")


class StateSnapshotData(BaseModel):
    """状态快照数据
    
    Attributes:
        profile_data: 用户档案数据
    """
    profile_data: Dict[str, Any] = Field(..., description="用户档案数据")


EventDataType = Union[
    CodeEditData,
    AiHelpRequestData,
    SubmissionData,
    DomElementSelectData,
    UserIdleData,
    PageFocusChangeData,
    StateSnapshotData
]


class BehaviorEvent(BaseModel):
    """
    行为事件模型，对应前端behavior_tracker.js捕获的事件
    
    记录用户在学习过程中的各种交互行为，用于行为分析和学习状态评估。
    
    Attributes:
        participant_id: 参与者ID，用于标识特定用户
        event_type: 事件类型，枚举值
        event_data: 事件数据，根据事件类型有不同的结构
        timestamp: 事件发生的时间戳，可选字段，默认为当前时间
    """

    # 与 TDD-II-07 对齐的事件类型枚举（若将来扩展只需在此添加）TODO：ceq可能添加热力图事件（heatmap_snapshot）
    # 使用已定义的 EventType 枚举类

    participant_id: str = Field(..., description="参与者ID，用于标识特定用户")
    event_type: EventType = Field(..., description="事件类型")
    event_data: Dict[str, Any]  = Field(..., description="事件数据，根据事件类型有不同的结构")
    timestamp: Optional[datetime] = Field(None, description="事件发生的时间戳，可选字段，默认为当前时间")

    
    class Config:
        orm_mode = True