import logging
import redis
from typing import Dict, Any
from sqlalchemy.orm import Session
from app.crud.crud_event import event as crud_event
from app.schemas.behavior import BehaviorEvent
from datetime import datetime, timedelta, UTC, timezone
import json

# 导入BKT模型
from ..models.bkt import BKTModel

# 移除循环导入
# from .behavior_interpreter_service import BehaviorInterpreterService

# 配置日志
logger = logging.getLogger(__name__)

class StudentProfile:
    def __init__(self, participant_id, is_new_user=True,):
        self.participant_id = participant_id  # TODO: cxz 需要从会话或参数中获取participant_id
        self.is_new_user = is_new_user
        # 认知状态
        self.bkt_model = {}  # { 'topic_id': BKT_instance }  # TODO: cxz 需要实现BKT模型，用于追踪知识点掌握情况
        # 情感状态 - 连续表示
        self.emotion_state = {
            'sentiment_confidence': {
                'positive': 0.0,      # [0,1] 积极情绪置信度
                'negative': 0.0,      # [0,1] 消极情绪置信度
                'neutral': 1.0        # [0,1] 中性情绪置信度
            },
            'frustration_level': 0.0,     # [0,1] 挫败程度
            'engagement_level': 0.5,      # [0,1] 参与度
            'confidence_level': 0.5       # [0,1] 自信程度
        }
        # 行为模式 - 连续表示
        self.behavior_patterns = {
            'error_frequency': 0.0,        # [0,1] 错误频率（基于滑动窗口）
            'help_seeking_tendency': 0.0,  # [0,1] 求助倾向
            'persistence_score': 0.5,      # [0,1] 坚持度
            'learning_velocity': 0.5,      # [0,1] 学习速度
            'attention_stability': 0.5,    # [0,1] 注意力稳定性
            'submission_timestamps': [],   # 保留时间戳用于计算频率
            'recent_events': [],           # 保留最近事件用于滑动窗口计算
            'knowledge_level_history': {}, # { 'topic_id': { 'level': {'visits': 0, 'total_duration_ms': 0} } }
            
            # 代码问题记录 - 增强数据结构
            'coding_problems': [],         # 存储代码问题记录
            'recent_problems_window': [],  # 近期问题窗口用于实时分析
            
            # 重要编辑记录 - 增强数据结构
            'significant_edits': [],       # 存储重要编辑记录
            'recent_edits_window': [],     # 近期编辑窗口用于计算
            
            # 编辑统计信息 - 增强统计字段
            'edit_statistics': {
                'total_edits': 0,
                'html_edits': 0,
                'css_edits': 0,
                'js_edits': 0,
                'avg_edit_size': 0,
                'problem_frequency': 0.0,
                'total_deleted_chars': 0,   # 新增：总共删除字符数
                'total_added_chars': 0,     # 新增：总共新增字符数
                'net_change_chars': 0,      # 新增：净变化字符数
                'max_consecutive_edits': 0, # 新增：最大连续编辑次数
                'recent_edit_intensity': 0.0, # 新增：近期编辑强度
            },
            
            # 行为计数器 - 新增
            'behavior_counters': {
                'help_requests': 0,        # AI求助次数
                'focus_changes': 0,        # 页面焦点变化次数
                'idle_count': 0,           # 空闲次数
                'dom_selects': 0,          # DOM元素选择次数
                'code_edits': 0,           # 代码编辑次数
                'test_submissions': 0,     # 测试提交次数
                'test_passes': 0,          # 测试通过次数
                'test_fails': 0,           # 测试失败次数
            },
            
            # 时间窗口统计 - 新增
            'time_window_stats': {
                'last_hour': {
                    'edits': 0,
                    'problems': 0,
                    'help_requests': 0,
                    'submissions': 0
                },
                'last_30min': {
                    'edits': 0,
                    'problems': 0,
                    'help_requests': 0,
                    'submissions': 0
                },
                'last_15min': {
                    'edits': 0,
                    'problems': 0,
                    'help_requests': 0,
                    'submissions': 0
                }
            },
            
            # 编辑器特定统计 - 新增
            'editor_specific_stats': {
                'html': {
                    'total_edits': 0,
                    'avg_edit_size': 0,
                    'deleted_chars': 0,
                    'added_chars': 0,
                    'problem_count': 0
                },
                'css': {
                    'total_edits': 0,
                    'avg_edit_size': 0,
                    'deleted_chars': 0,
                    'added_chars': 0,
                    'problem_count': 0
                },
                'js': {
                    'total_edits': 0,
                    'avg_edit_size': 0,
                    'deleted_chars': 0,
                    'added_chars': 0,
                    'problem_count': 0
                }
            },
            
            # 学习模式指标 - 新增
            'learning_metrics': {
                'concept_grasp_rate': 0.5,    # 概念掌握速率
                'error_recovery_rate': 0.5,   # 错误恢复速率
                'attention_span': 300,        # 注意力时长（秒）
                'preferred_learning_style': 'visual',  # 偏好学习风格
                'difficulty_tolerance': 0.5   # 困难容忍度
            },
            
            # 会话状态 - 新增
            'session_state': {
                'current_topic': None,        # 当前学习主题
                'current_mode': 'learning',   # 当前模式：learning/test
                'session_start_time': None,   # 会话开始时间
                'active_duration': 0,         # 活跃时长（秒）
                'idle_duration': 0,           # 空闲时长（秒）
                'last_activity_time': None    # 最后活动时间
            }
        }
        
# user_state_service.py - 添加批量处理方法
def _handle_significant_edits_batch(self, participant_id, event_data, timestamp, user_state_service, is_replay):
    """处理批量重要编辑事件"""
    if user_state_service is not None and not is_replay:
        user_state_service.handle_significant_edits_batch(participant_id, event_data)

# 在 UserStateService 中添加处理方法
def handle_significant_edits_batch(self, participant_id: str, batch_data: Dict[str, Any]):
    """处理批量重要编辑事件"""
    try:
        edits = batch_data.get('edits', [])
        if not edits:
            return
            
        profile, _ = self.get_or_create_profile(participant_id, None)
        
        # 批量处理编辑记录
        for edit in edits:
            self._process_single_edit(profile, edit)
            
        logger.info(f"处理了 {len(edits)} 个批量编辑事件")
        
    except Exception as e:
        logger.error(f"处理批量编辑事件时发生错误: {e}")

def _process_single_edit(self, profile, edit_data: Dict[str, Any]):
    """处理单个编辑记录"""
    edit_record = {
        'timestamp': edit_data.get('timestamp', datetime.now(UTC).isoformat()),
        'editor': edit_data.get('editor'),
        'edit_type': edit_data.get('edit_type'),
        'net_change': edit_data.get('net_change', 0),
        'deleted_chars': edit_data.get('deleted_chars', 0),
        'added_chars': edit_data.get('added_chars', 0),
        'total_modified': edit_data.get('total_modified', 0),
        'duration_ms': edit_data.get('duration_ms', 0),
        'consecutive_edits': edit_data.get('consecutive_edits', 0)
    }
    
    # 更新到 Redis
    key = f"user_profile:{profile.participant_id}"
    
    # 获取现有编辑记录
    try:
        current_edits = self.redis_client.json().get(key, '.behavior_patterns.significant_edits') or []
    except Exception:
        current_edits = []
    
    # 添加新记录（保持最近100个编辑）
    current_edits.append(edit_record)
    if len(current_edits) > 100:
        current_edits = current_edits[-100:]
    
    # 更新编辑统计
    edit_stats = profile.behavior_patterns.get('edit_statistics', {})
    total_edits = edit_stats.get('total_edits', 0) + 1
    
    # 按编辑器类型统计
    editor_type = edit_data.get('editor', 'unknown')
    editor_key = f"{editor_type}_edits"
    edit_stats[editor_key] = edit_stats.get(editor_key, 0) + 1
    
    # 计算平均编辑大小
    current_avg = edit_stats.get('avg_edit_size', 0)
    edit_size = edit_data.get('total_modified', abs(edit_data.get('net_change', 0)))
    new_avg = (current_avg * (total_edits - 1) + edit_size) / total_edits
    
    edit_stats['total_edits'] = total_edits
    edit_stats['avg_edit_size'] = new_avg
    
    # 批量更新
    set_dict = {
        '.behavior_patterns.significant_edits': current_edits,
        '.behavior_patterns.edit_statistics': edit_stats
    }
    
    self.set_profile(profile, set_dict)

def handle_significant_edit(self, participant_id: str, edit_data: Dict[str, Any]):
    """处理重要编辑事件"""
    try:
        profile, _ = self.get_or_create_profile(participant_id, None)
        
        # 添加到编辑记录
        edit_record = {
            'timestamp': datetime.now(UTC).isoformat(),
            'editor': edit_data.get('editor'),
            'edit_type': edit_data.get('edit_type'),
            'net_change': edit_data.get('net_change', 0),
            'absolute_change': edit_data.get('absolute_change', 0),
            'duration_ms': edit_data.get('duration_ms', 0),
            'consecutive_edits': edit_data.get('consecutive_edits', 0)
        }
        
        key = f"user_profile:{participant_id}"
        
        # 获取现有编辑记录
        try:
            current_edits = self.redis_client.json().get(key, '.behavior_patterns.significant_edits') or []
        except Exception:
            current_edits = []
        
        # 添加新记录（保持最近100个编辑）
        current_edits.append(edit_record)
        if len(current_edits) > 100:
            current_edits = current_edits[-100:]
        
        # 更新编辑统计
        edit_stats = profile.behavior_patterns.get('edit_statistics', {})
        total_edits = edit_stats.get('total_edits', 0) + 1
        
        # 计算平均编辑大小
        current_avg = edit_stats.get('avg_edit_size', 0)
        new_avg = (current_avg * (total_edits - 1) + abs(edit_data.get('net_change', 0))) / total_edits
        
        edit_stats['total_edits'] = total_edits
        edit_stats['avg_edit_size'] = new_avg
        
        # 批量更新
        set_dict = {
            '.behavior_patterns.significant_edits': current_edits,
            '.behavior_patterns.edit_statistics': edit_stats
        }
        
        self.set_profile(profile, set_dict)
        logger.info(f"记录用户 {participant_id} 的重要编辑: {edit_data}")
        
    except Exception as e:
        logger.error(f"处理重要编辑时发生错误: {e}")
            
def handle_significant_edit(self, participant_id: str, edit_data: Dict[str, Any]):
    """处理重要编辑事件"""
    try:
        profile, _ = self.get_or_create_profile(participant_id, None)
        
        # 添加到编辑记录
        edit_record = {
            'timestamp': datetime.now(UTC).isoformat(),
            'editor': edit_data.get('editor'),
            'edit_type': edit_data.get('edit_type'),
            'net_change': edit_data.get('net_change', 0),
            'absolute_change': edit_data.get('absolute_change', 0),
            'duration_ms': edit_data.get('duration_ms', 0),
            'consecutive_edits': edit_data.get('consecutive_edits', 0)
        }
        
        key = f"user_profile:{participant_id}"
        
        # 获取现有编辑记录
        try:
            current_edits = self.redis_client.json().get(key, '.behavior_patterns.significant_edits') or []
        except Exception:
            current_edits = []
        
        # 添加新记录（保持最近100个编辑）
        current_edits.append(edit_record)
        if len(current_edits) > 100:
            current_edits = current_edits[-100:]
        
        # 更新编辑统计
        edit_stats = profile.behavior_patterns.get('edit_statistics', {})
        total_edits = edit_stats.get('total_edits', 0) + 1
        
        # 计算平均编辑大小
        current_avg = edit_stats.get('avg_edit_size', 0)
        new_avg = (current_avg * (total_edits - 1) + abs(edit_data.get('net_change', 0))) / total_edits
        
        edit_stats['total_edits'] = total_edits
        edit_stats['avg_edit_size'] = new_avg
        
        # 批量更新
        set_dict = {
            '.behavior_patterns.significant_edits': current_edits,
            '.behavior_patterns.edit_statistics': edit_stats
        }
        
        self.set_profile(profile, set_dict)
        logger.info(f"记录用户 {participant_id} 的重要编辑: {edit_data}")
        
    except Exception as e:
        logger.error(f"处理重要编辑时发生错误: {e}")
    # TODO: 需要检查实现to_dict和from_dict方法
    def to_dict(self) -> Dict[str, Any]:
        """将StudentProfile序列化为字典"""
        # 序列化BKT模型
        serialized_bkt_models = {}
        for topic_id, bkt_model in self.bkt_model.items():
            if isinstance(bkt_model, BKTModel):
                serialized_bkt_models[topic_id] = bkt_model.to_dict()
            else:
                # 如果已经是字典形式（从数据库恢复时），直接使用
                serialized_bkt_models[topic_id] = bkt_model
        
        # 序列化行为模式中的时间戳
        serialized_behavior_patterns = self.behavior_patterns.copy()
        if 'submission_timestamps' in serialized_behavior_patterns:
            # 将datetime对象转换为ISO字符串
            serialized_behavior_patterns['submission_timestamps'] = [
                ts.isoformat() if isinstance(ts, datetime) else ts 
                for ts in serialized_behavior_patterns['submission_timestamps']
            ]
        
        if 'recent_events' in serialized_behavior_patterns:
            # 将recent_events中的时间戳转换为ISO字符串
            serialized_recent_events = []
            for event in serialized_behavior_patterns['recent_events']:
                serialized_event = event.copy()
                if 'timestamp' in serialized_event and isinstance(serialized_event['timestamp'], datetime):
                    serialized_event['timestamp'] = serialized_event['timestamp'].isoformat()
                serialized_recent_events.append(serialized_event)
            serialized_behavior_patterns['recent_events'] = serialized_recent_events
        
        return {
            'is_new_user': self.is_new_user,
            'bkt_model': serialized_bkt_models,
            'emotion_state': self.emotion_state,
            'behavior_patterns': serialized_behavior_patterns
        }
    
    @classmethod
    def from_dict(cls, participant_id: str, data: Dict[str, Any]) -> 'StudentProfile':
        """从字典反序列化创建StudentProfile"""
        # 注意：从数据库恢复的用户不是新用户
        profile = cls(participant_id, is_new_user=data.get('is_new_user', False))
        
        # 反序列化BKT模型
        bkt_models = data.get('bkt_model', {})
        deserialized_bkt_models = {}
        for topic_id, bkt_data in bkt_models.items():
            if isinstance(bkt_data, dict):
                # 如果是字典形式，反序列化为BKTModel对象
                deserialized_bkt_models[topic_id] = BKTModel.from_dict(bkt_data)
            else:
                # 如果已经是BKTModel对象，直接使用
                deserialized_bkt_models[topic_id] = bkt_data
        profile.bkt_model = deserialized_bkt_models
        
        profile.emotion_state = data.get('emotion_state', {
            'sentiment_confidence': {'positive': 0.0, 'negative': 0.0, 'neutral': 1.0},
            'frustration_level': 0.0,
            'engagement_level': 0.5,
            'confidence_level': 0.5
        })
        
        # 反序列化行为模式
        behavior_patterns = data.get('behavior_patterns', {
            'error_frequency': 0.0,
            'help_seeking_tendency': 0.0,
            'persistence_score': 0.5,
            'learning_velocity': 0.5,
            'attention_stability': 0.5,
            'submission_timestamps': [],
            'recent_events': [],
            'knowledge_level_history': {}
        })
        
        # 反序列化时间戳
        if 'submission_timestamps' in behavior_patterns:
            # 将ISO字符串转换回datetime对象
            submission_timestamps = []
            for ts in behavior_patterns['submission_timestamps']:
                if isinstance(ts, str):
                    try:
                        submission_timestamps.append(datetime.fromisoformat(ts))
                    except ValueError:
                        # 如果解析失败，使用当前时间
                        submission_timestamps.append(datetime.now(UTC))
                else:
                    submission_timestamps.append(ts or datetime.now(UTC))
            behavior_patterns['submission_timestamps'] = submission_timestamps
        
        if 'recent_events' in behavior_patterns:
            # 反序列化recent_events中的时间戳
            recent_events = []
            for event in behavior_patterns['recent_events']:
                deserialized_event = event.copy()
                if 'timestamp' in deserialized_event and isinstance(deserialized_event['timestamp'], str):
                    try:
                        deserialized_event['timestamp'] = datetime.fromisoformat(deserialized_event['timestamp'])
                    except ValueError:
                        # 如果解析失败，使用当前时间
                        deserialized_event['timestamp'] = datetime.now(UTC)
                recent_events.append(deserialized_event)
            behavior_patterns['recent_events'] = recent_events
        
        profile.behavior_patterns = behavior_patterns
        return profile


class UserStateService:
    # 快照创建间隔（示例：每1次事件或每1分钟）
    SNAPSHOT_EVENT_INTERVAL = 1
    SNAPSHOT_TIME_INTERVAL = timedelta(minutes=1)
    
    def __init__(self, redis_client: redis.Redis):
        self.redis_client = redis_client
    
    def handle_event(self, event: BehaviorEvent, db: Session, background_tasks=None):
        """处理事件，并可能创建快照"""
        # 修改调用方式：使用依赖注入
        from .behavior_interpreter_service import behavior_interpreter_service
        behavior_interpreter_service.interpret_event(
            event, 
            user_state_service=self, 
            db_session=db, 
            is_replay=False
        )
        
        # 事件处理后，检查是否需要创建快照
        self._maybe_create_snapshot(event.participant_id, db, background_tasks)

    def handle_frustration_event(self, participant_id: str, frustration_increase: float = 0.2):
        """
        处理挫败事件 - 连续更新挫败程度
        
        Args:
            participant_id: 参与者ID
            frustration_increase: 挫败程度增加量 [0,1]
        """
        try:
            # 获取用户档案
            profile, _ = self.get_or_create_profile(participant_id, None)
            
            # 使用指数移动平均更新挫败程度
            current_frustration = profile.emotion_state['frustration_level']
            new_frustration = min(current_frustration + frustration_increase, 1.0)
            
            # 使用 set_profile 方法更新 Redis 中的挫败状态
            set_dict = {
                'emotion_state.frustration_level': new_frustration
            }
            self.set_profile(profile, set_dict)
            
            logger.info(f"UserStateService: 更新用户 {participant_id} 挫败程度为 {new_frustration:.3f}")
        except Exception as e:
            logger.error(f"UserStateService: 处理挫败事件时发生错误: {e}")

    def handle_ai_help_request(self, participant_id: str, content_title: str = None):
        """
        处理AI求助请求事件
        
        Args:
            participant_id: 参与者ID
            content_title: 内容标题
        """
        try:
            # 获取用户档案
            profile, _ = self.get_or_create_profile(participant_id, None)
            
            set_dict = {}
            
            # 使用 RedisJSON 实现类似 setdefault 的逻辑
            key = f"user_profile:{participant_id}"
            
            # 检查 help_requests 字段是否存在，如果不存在则设置为0
            try:
                current_help_requests = self.redis_client.json().get(key, '.behavior_patterns.help_requests')
            except Exception:
                # 字段不存在，设置为0
                self.redis_client.json().set(key, '.behavior_patterns.help_requests', 0)
                current_help_requests = 0
            
            # 递增求助计数
            new_help_requests = current_help_requests + 1
            set_dict['.behavior_patterns.help_requests'] = new_help_requests
            
            # 如果有特定内容标题，也增加对应的提问计数
            if content_title:
                counter_key = f"question_count_{content_title}"
                try:
                    current_question_count = self.redis_client.json().get(key, f'.behavior_patterns["{counter_key}"]')
                except Exception:
                    # 字段不存在，设置为0
                    self.redis_client.json().set(key, f'.behavior_patterns["{counter_key}"]', 0)
                    current_question_count = 0
                
                # 递增提问计数
                new_question_count = current_question_count + 1
                set_dict[f'.behavior_patterns["{counter_key}"]'] = new_question_count
            
            # 使用 set_profile 批量更新 Redis 中的字段
            self.set_profile(profile, set_dict)
            
            # 注释掉旧的实现方式
            # # 增加求助计数
            # profile.behavior_counters.setdefault("help_requests", 0)
            # profile.behavior_counters["help_requests"] += 1
            # 
            # # 增加特定内容的提问计数
            # if content_title:
            #     counter_key = f"question_count_{content_title}"
            #     profile.behavior_counters.setdefault(counter_key, 0)
            #     profile.behavior_counters[counter_key] += 1
            
            logger.info(f"UserStateService: 增加用户 {participant_id} 的求助计数")
        except Exception as e:
            logger.error(f"UserStateService: 处理AI求助请求事件时发生错误: {e}")

    def handle_lightweight_event(self, participant_id: str, event_type: str):
        """
        处理轻量级事件
        
        Args:
            participant_id: 参与者ID
            event_type: 事件类型
        """
        try:
            # 获取用户档案
            profile, _ = self.get_or_create_profile(participant_id, None)
            
            # 根据事件类型增加相应计数
            key_map = {
                "page_focus_change": "focus_changes",
                "user_idle": "idle_count",
                "dom_element_select": "dom_selects",
                "code_edit": "code_edits"
            }
            
            counter_key = key_map.get(event_type)
            if counter_key:
                # 使用 RedisJSON 实现类似 setdefault 的逻辑
                key = f"user_profile:{participant_id}"
                
                # 检查字段是否存在，如果不存在则设置为0
                try:
                    current_count = self.redis_client.json().get(key, f'.behavior_patterns.{counter_key}')
                except Exception:
                    # 字段不存在，设置为0
                    self.redis_client.json().set(key, f'.behavior_patterns.{counter_key}', 0)
                    current_count = 0
                
                # 递增计数
                new_count = current_count + 1
                self.redis_client.json().set(key, f'.behavior_patterns.{counter_key}', new_count)
                
                # 注释掉旧的实现方式
                # profile.behavior_counters.setdefault(counter_key, 0)
                # profile.behavior_counters[counter_key] += 1
                # 
                # # 使用 set_profile 方法更新 Redis 中的计数
                # set_dict = {
                #     f'behavior_counters.{counter_key}': profile.behavior_counters[counter_key]
                # }
                # self.set_profile(profile, set_dict)
                
                logger.info(f"UserStateService: 增加用户 {participant_id} 的 {counter_key} 计数")
        except Exception as e:
            logger.error(f"UserStateService: 处理轻量级事件时发生错误: {e}")

    def handle_knowledge_level_access(self, participant_id: str, event_data: dict):
        profile, _ = self.get_or_create_profile(participant_id)
        
        topic_id = event_data.get('topic_id')
        level = event_data.get('level')
        action = event_data.get('action')
        duration_ms = event_data.get('duration_ms')

        if not topic_id or not level or not action:
            return

        # 按 topic_id 对 history 进行分组
        history = profile.behavior_patterns.setdefault('knowledge_level_history', {})
        topic_history = history.setdefault(topic_id, {})
        level_stats = topic_history.setdefault(str(level), {'visits': 0, 'total_duration_ms': 0})

        if action == 'enter':
            level_stats['visits'] += 1
        elif action == 'leave' and duration_ms is not None:
            level_stats['total_duration_ms'] += duration_ms
        
        # 使用 set_profile 更新 Redis
        set_dict = {
            f'behavior_patterns.knowledge_level_history.{topic_id}.{level}': level_stats
        }
        self.set_profile(profile, set_dict)
        logger.info(f"Updated knowledge level {level} for topic {topic_id} stats for {participant_id}")

    def get_or_create_profile(self, participant_id: str, db: Session = None, group: str = "experimental") -> tuple[StudentProfile, bool]:
        """
        获取或创建用户配置
        
        Args:
            participant_id: 参与者ID
            db: 数据库会话（可选）
            group: 实验分组，默认为'experimental'
            
        Returns:
            tuple: (profile, is_new_user)
        """
        key = f"user_profile:{participant_id}"
        profile_data = self.redis_client.json().get(key)

        if profile_data:
            # 缓存命中
            return StudentProfile.from_dict(participant_id, profile_data), False

        # 缓存未命中
        is_new_user = False
        if db:
            from ..crud.crud_participant import participant
            from ..schemas.participant import ParticipantCreate
            
            participant_obj = participant.get(db, obj_id=participant_id)
            if not participant_obj:
                create_schema = ParticipantCreate(id=participant_id, group=group)
                participant.create(db, obj_in=create_schema)
                is_new_user = True

            logger.info(f"Cache miss for {participant_id}. Attempting recovery from history.")
            self._recover_from_history_with_snapshot(participant_id, db)
            
            # 再次从Redis获取数据，因为_recover_from_history_with_snapshot会写入Redis
            profile_data = self.redis_client.json().get(key)
            if profile_data:
                profile = StudentProfile.from_dict(participant_id, profile_data)
                profile.is_new_user = is_new_user
                return profile, is_new_user

        # 如果没有数据库会话或恢复失败，创建一个新的Profile
        logger.info(f"Creating a new default profile for {participant_id}.")
        new_profile = StudentProfile(participant_id, is_new_user=True)
        self.save_profile(new_profile)
        return new_profile, True

    def _recover_from_history_with_snapshot(self, participant_id: str, db: Session):
        # 1. 查找最新的快照
        latest_snapshot = crud_event.get_latest_snapshot(db, participant_id=participant_id)
        
        events_after_snapshot = []  # 初始化事件列表
        
        if latest_snapshot:
            # 2a. 如果找到快照，从快照恢复
            logger.info(f"Found snapshot for {participant_id}. Restoring from snapshot...")
            # 反序列化快照数据
            # 检查 event_data 是否是 StateSnapshotData 实例或字典
            if isinstance(latest_snapshot.event_data, dict) and 'profile_data' in latest_snapshot.event_data:
                profile_data = latest_snapshot.event_data['profile_data']
            else:
                # 兼容旧的快照数据结构
                profile_data = latest_snapshot.event_data
            temp_profile = StudentProfile.from_dict(participant_id, profile_data)
            self.save_profile(temp_profile)
            
            # 3a. 获取快照之后的事件
            events_after_snapshot = crud_event.get_after_timestamp(
                db, 
                participant_id=participant_id, 
                timestamp=latest_snapshot.timestamp
            )
            
            logger.info(f"Found {len(events_after_snapshot)} events to replay after snapshot for {participant_id}.")
        else:
            # 2b. 如果没有快照，检查是否有历史事件
            logger.info(f"No snapshot found for {participant_id}. Checking for history...")
            
            # 获取所有历史事件来判断是否是新用户
            all_history_events = crud_event.get_by_participant(db, participant_id=participant_id)
            
            if all_history_events:
                # 如果有历史事件，说明不是新用户
                logger.info(f"Found {len(all_history_events)} historical events for {participant_id}. Not a new user.")
                temp_profile = StudentProfile(participant_id, is_new_user=False)
                self.save_profile(temp_profile)
            else:
                # 如果没有历史事件，说明是新用户
                logger.info(f"No history found for {participant_id}. This is a new user.")
                temp_profile = StudentProfile(participant_id, is_new_user=True)
                self.save_profile(temp_profile)
            
            # 3b. 获取所有历史事件用于回放
            events_after_snapshot = all_history_events or []
            
        if not events_after_snapshot:
            logger.info(f"No events to replay for {participant_id}.")
            return  # 没有事件需要回放
        
        # 4. 回放事件
        from .behavior_interpreter_service import behavior_interpreter_service
        for event in events_after_snapshot:
            # 将数据库模型转换为Pydantic模型
            # 如果event已经是BehaviorEvent实例或具有正确属性的mock对象，则直接使用
            if isinstance(event, BehaviorEvent):
                event_schema = event
            else:
                try:
                    # 如果event是EventLog对象（来自数据库），需要手动构造字典
                    if hasattr(event, '__dict__'):
                        # 从EventLog对象创建字典
                        event_dict = {
                            'participant_id': event.participant_id,
                            'event_type': event.event_type,
                            'event_data': event.event_data,
                            'timestamp': event.timestamp
                        }
                        event_schema = BehaviorEvent.model_validate(event_dict)
                    else:
                        event_schema = BehaviorEvent.model_validate(event)
                except Exception:
                    # 如果验证失败（例如在测试中使用mock对象），则跳过该事件
                    logger.warning(f"Failed to validate event {event}. Skipping.")
                    continue
            # 调用解释器，但在回放模式下
            behavior_interpreter_service.interpret_event(
                event_schema, 
                user_state_service=self, 
                db_session=db, 
                is_replay=True
            )
        
        logger.info(f"Recovery complete for {participant_id}.")

    def _maybe_create_snapshot(self, participant_id: str, db: Session, background_tasks=None):
        """根据策略判断是否需要创建快照"""
        key = f"user_profile:{participant_id}"
        profile_data = self.redis_client.json().get(key)
        if profile_data is None:
            return

        # 获取最新快照信息
        latest_snapshot = crud_event.get_latest_snapshot(db, participant_id=participant_id)
        
        event_count_since_snapshot = 0
        if latest_snapshot:
            # 计算自上次快照以来的事件数量
            event_count_since_snapshot = crud_event.get_count_after_timestamp(
                db, 
                participant_id=participant_id, 
                timestamp=latest_snapshot.timestamp
            )
        else:
            # 如果没有快照，获取总事件数
            event_count_since_snapshot = crud_event.get_count_by_participant(db, participant_id=participant_id)
            
        # 检查是否满足快照创建条件
        # 确保时间戳有时区信息
        if latest_snapshot:
            snapshot_timestamp = latest_snapshot.timestamp
            # 如果时间戳是naive的，将其转换为UTC时区
            if snapshot_timestamp.tzinfo is None:
                snapshot_timestamp = snapshot_timestamp.replace(tzinfo=timezone.utc)
        else:
            snapshot_timestamp = datetime.min.replace(tzinfo=timezone.utc)
        
        time_since_last_snapshot = datetime.now(UTC) - snapshot_timestamp
        
        if (event_count_since_snapshot >= self.SNAPSHOT_EVENT_INTERVAL or 
            time_since_last_snapshot >= self.SNAPSHOT_TIME_INTERVAL):
            
            logger.info(f"Creating snapshot for {participant_id}...")
            logger.info(f"Snapshot details - Event count since last snapshot: {event_count_since_snapshot}, Time since last snapshot: {time_since_last_snapshot}")
            
            # 创建快照事件
            from ..schemas.behavior import EventType, StateSnapshotData
            snapshot_event = BehaviorEvent(
                participant_id=participant_id,
                event_type=EventType.STATE_SNAPSHOT,
                event_data=StateSnapshotData(profile_data=profile_data),
                timestamp=datetime.now(UTC)
            )
            
            # 输出快照数据到日志（限制长度以避免日志过大）
            logger.info(f"Snapshot data for {participant_id}: {str(profile_data)[:500]}...")
            
            # 异步保存快照
            if background_tasks:
                from fastapi import BackgroundTasks
                if isinstance(background_tasks, BackgroundTasks):
                    background_tasks.add_task(crud_event.create_from_behavior, db=db, obj_in=snapshot_event)
                else:
                    # 兼容其他后台任务机制
                    background_tasks.add_task(crud_event.create_from_behavior, db, snapshot_event)
                logger.info(f"Snapshot scheduled for async save: {participant_id}")
            else:
                # 同步保存（备用方案）
                crud_event.create_from_behavior(db, obj_in=snapshot_event)
                logger.info(f"Snapshot created for {participant_id}")
            
            # 清理旧快照
            self._cleanup_old_snapshots(participant_id, db)

    def _cleanup_old_snapshots(self, participant_id: str, db: Session, keep_latest: int = 3):
        """科研需求：保留所有快照数据，不进行清理"""
        # 注释掉原有的清理逻辑，以保留所有快照用于科研分析
        # snapshots = crud_event.get_all_snapshots(db, participant_id=participant_id)
        # 
        # if len(snapshots) > keep_latest:
        #     # 获取需要删除的快照
        #     snapshots_to_delete = snapshots[:-keep_latest]
        #     
        #     for snapshot in snapshots_to_delete:
        #         crud_event.remove(db, obj_id=snapshot.id)
        #     
        #     logger.info(f"Cleaned up {len(snapshots_to_delete)} old snapshots for {participant_id}.")
        logger.info(f"Research mode: Keeping all snapshots for {participant_id}. No cleanup performed.")

    def update_bkt_on_submission(self, participant_id: str, topic_id: str, is_correct: bool) -> float:
        """
        根据测试提交结果更新BKT模型
        
        Args:
            participant_id: 参与者ID
            topic_id: 知识点ID
            is_correct: 提交结果是否正确
            
        Returns:
            更新后的知识点掌握概率
        """
        # 获取或创建用户档案
        profile, _ = self.get_or_create_profile(participant_id, None)  # 注意：这里可能需要传入db参数
        
        # 获取或创建该知识点的BKT模型
        # if topic_id not in profile.bkt_model:
        #     profile.bkt_model[topic_id] = BKTModel()
        
        # 使用 RedisJSON 操作 Redis 中的 BKT 模型
        key = f"user_profile:{participant_id}"
        
        # 检查该知识点的BKT模型是否存在
        try:
            bkt_model_data = self.redis_client.json().get(key, f'.bkt_model.{topic_id}')
        except Exception:
            # 如果字段不存在，创建新的BKT模型
            new_bkt_model = BKTModel()
            self.redis_client.json().set(key, f'.bkt_model.{topic_id}', new_bkt_model.to_dict())
            bkt_model_data = new_bkt_model.to_dict()
        
        # 从数据恢复BKT模型对象
        if isinstance(bkt_model_data, dict):
            bkt_model = BKTModel.from_dict(bkt_model_data)
        else:
            bkt_model = bkt_model_data
        
        # 更新BKT模型
        # mastery_prob = profile.bkt_model[topic_id].update(is_correct)
        
        # 更新BKT模型
        mastery_prob = bkt_model.update(is_correct)
        
        # 使用 set_profile 函数更新字段
        set_dict = {
            f'bkt_model.{topic_id}': bkt_model.to_dict()
        }
        self.set_profile(profile, set_dict)
        
        logger.info(f"Updated BKT model for participant {participant_id}, topic {topic_id}. "
              f"Correct: {is_correct}, New mastery probability: {mastery_prob:.3f}")
        
        return mastery_prob

    def maybe_create_snapshot(self, participant_id: str, db: Session, background_tasks=None):
        """
        公共方法，用于根据策略判断是否需要创建快照
        
        Args:
            participant_id: 参与者ID
            db: 数据库会话
            background_tasks: 后台任务（可选）
        """
        self._maybe_create_snapshot(participant_id, db, background_tasks)
        
    def save_profile(self, profile: StudentProfile):
        key = f"user_profile:{profile.participant_id}"
        self.redis_client.json().set(key, '.', profile.to_dict())

    def set_profile(self, profile: StudentProfile, set_dict: dict):
        """
        使用 RedisJSON 技术直接修改 Redis 中用户档案的特定字段
        
        Args:
            profile: 用户档案对象
            set_dict: 要修改的字段字典，键为字段路径，值为新值
                    例如: {
                        'emotion_state.current_sentiment': 'HAPPY',
                        'behavior_counters.error_count': 5,
                        'bkt_model.topic_1.mastery_prob': 0.8
                    }
        """
        if not set_dict:
            logger.warning("set_dict is empty, no fields to update")
            return
            
        key = f"user_profile:{profile.participant_id}"
        
        try:
            # 输出更新前的字段值
            logger.info(f"UserStateService: 准备更新用户 {profile.participant_id} 的字段: {set_dict}")
            
            # 使用 RedisJSON 的 JSON.SET 命令逐个更新字段
            for field_path, new_value in set_dict.items():
                # 确保字段路径以 '.' 开头，符合 RedisJSON 的路径格式
                if not field_path.startswith('.'):
                    field_path = '.' + field_path
                
                # 检查并创建必要的中间结构
                self._ensure_intermediate_structure(key, field_path)
                
                # 获取更新前的值用于日志输出
                try:
                    old_value = self.redis_client.json().get(key, field_path)
                except Exception:
                    old_value = None
                
                # 直接使用 JSON.SET 命令更新特定字段
                result = self.redis_client.json().set(key, field_path, new_value)
                
                if result:
                    logger.info(f"UserStateService: 成功更新用户 {profile.participant_id} 的字段 '{field_path}' 从 '{old_value}' 到 '{new_value}'")
                else:
                    logger.warning(f"UserStateService: 更新用户 {profile.participant_id} 的字段 '{field_path}' 失败")
            
            logger.info(f"UserStateService: 用户 {profile.participant_id} 的字段更新完成")
            
        except Exception as e:
            logger.error(f"UserStateService: 更新用户 {profile.participant_id} 的字段时发生错误: {str(e)}")
            raise
    
    def _ensure_intermediate_structure(self, key: str, field_path: str):
        """
        确保嵌套字段的中间结构存在
        
        Args:
            key: Redis键
            field_path: 字段路径，如 '.behavior_counters.custom_metrics.engagement_score'
        """
        try:
            # 分解路径，获取所有中间路径
            path_parts = field_path.strip('.').split('.')
            
            # 逐级检查并创建中间结构
            current_path = ""
            for i, part in enumerate(path_parts[:-1]):  # 除了最后一个部分
                if current_path:
                    current_path += "." + part
                else:
                    current_path = part
                
                # 检查当前路径是否存在
                try:
                    self.redis_client.json().get(key, f".{current_path}")
                except Exception:
                    # 路径不存在，创建空对象
                    self.redis_client.json().set(key, f".{current_path}", {})
                    logger.debug(f"Created intermediate structure at .{current_path}")
                    
        except Exception as e:
            logger.warning(f"Failed to ensure intermediate structure for {field_path}: {e}")

    def update_emotional_state(self, participant_id: str, sentiment_update: Dict[str, float], weight: float = 0.3):
        """
        使用指数移动平均更新情感状态
        
        Args:
            participant_id: 参与者ID
            sentiment_update: 情感更新字典，如 {'positive': 0.1, 'negative': -0.1}
            weight: 更新权重 [0,1]
        """
        try:
            profile, _ = self.get_or_create_profile(participant_id, None)
            
            # 获取当前情感状态
            current_sentiment = profile.emotion_state['sentiment_confidence']
            
            # 应用指数移动平均更新
            new_sentiment = {}
            for sentiment_type, current_value in current_sentiment.items():
                update_value = sentiment_update.get(sentiment_type, 0.0)
                new_value = current_value * (1 - weight) + update_value * weight
                new_sentiment[sentiment_type] = max(0.0, min(1.0, new_value))
            
            # 归一化确保总和为1
            total = sum(new_sentiment.values())
            if total > 0:
                for sentiment_type in new_sentiment:
                    new_sentiment[sentiment_type] /= total
            
            # 更新挫败程度（基于消极情绪）
            profile.emotion_state['frustration_level'] = new_sentiment['negative']
            
            # 更新参与度（基于积极情绪）
            profile.emotion_state['engagement_level'] = new_sentiment['positive']
            
            # 保存更新
            set_dict = {
                'emotion_state.sentiment_confidence': new_sentiment,
                'emotion_state.frustration_level': new_sentiment['negative'],
                'emotion_state.engagement_level': new_sentiment['positive']
            }
            self.set_profile(profile, set_dict)
            
            logger.info(f"更新用户 {participant_id} 情感状态: {new_sentiment}")
            
        except Exception as e:
            logger.error(f"更新情感状态时发生错误: {e}")

    def update_behavior_patterns(self, participant_id: str, event_type: str, event_data: Dict = None):
        """
        更新行为模式指标
        
        Args:
            participant_id: 参与者ID
            event_type: 事件类型
            event_data: 事件数据
        """
        try:
            profile, _ = self.get_or_create_profile(participant_id, None)
            key = f"user_profile:{participant_id}"
            
            # 添加事件时间戳
            current_time = datetime.now(UTC)
            
            # 更新最近事件列表（保留最近100个事件）
            recent_events = profile.behavior_patterns['recent_events']
            recent_events.append({
                'event_type': event_type,
                'timestamp': current_time,
                'event_data': event_data or {}
            })
            
            # 保持列表长度限制
            if len(recent_events) > 100:
                recent_events = recent_events[-100:]
            
            # 计算滑动窗口指标
            window_start = current_time - timedelta(minutes=10)  # 10分钟窗口
            window_events = [e for e in recent_events if e['timestamp'] >= window_start]
            
            # 计算错误频率
            error_events = [e for e in window_events if e['event_type'] == 'test_submission' 
                          and e['event_data'].get('is_correct') is False]
            error_frequency = len(error_events) / max(len(window_events), 1)
            
            # 计算求助频率
            help_events = [e for e in window_events if e['event_type'] == 'ai_help_request']
            help_frequency = len(help_events) / max(len(window_events), 1)
            
            # 更新行为模式
            set_dict = {
                'behavior_patterns.recent_events': recent_events,
                'behavior_patterns.error_frequency': error_frequency,
                'behavior_patterns.help_seeking_tendency': help_frequency
            }
            
            # 更新提交时间戳
            if event_type == 'test_submission':
                submission_timestamps = profile.behavior_patterns['submission_timestamps']
                submission_timestamps.append(current_time)
                
                # 保持最近50个提交
                if len(submission_timestamps) > 50:
                    submission_timestamps = submission_timestamps[-50:]
                
                set_dict['behavior_patterns.submission_timestamps'] = submission_timestamps
                
                # 计算学习速度（基于提交间隔）
                if len(submission_timestamps) >= 2:
                    intervals = []
                    for i in range(1, len(submission_timestamps)):
                        interval = (submission_timestamps[i] - submission_timestamps[i-1]).total_seconds()
                        intervals.append(interval)
                    
                    if intervals:
                        avg_interval = sum(intervals) / len(intervals)
                        # 将间隔转换为学习速度（间隔越短，速度越快）
                        learning_velocity = min(1.0, 300.0 / max(avg_interval, 30.0))  # 30秒=1.0, 300秒=0.0
                        set_dict['behavior_patterns.learning_velocity'] = learning_velocity
            
            self.set_profile(profile, set_dict)
            
            logger.debug(f"更新用户 {participant_id} 行为模式: error_freq={error_frequency:.3f}, help_freq={help_frequency:.3f}")
            
        except Exception as e:
            logger.error(f"更新行为模式时发生错误: {e}")

    def calculate_frustration_index(self, participant_id: str) -> float:
        """
        计算综合挫败指数
        
        Args:
            participant_id: 参与者ID
            
        Returns:
            挫败指数 [0,1]
        """
        try:
            profile, _ = self.get_or_create_profile(participant_id, None)
            
            # 获取各个指标
            emotional_frustration = profile.emotion_state['frustration_level']
            error_frequency = profile.behavior_patterns['error_frequency']
            help_seeking = profile.behavior_patterns['help_seeking_tendency']
            
            # 计算时间压力（基于提交频率）
            submission_timestamps = profile.behavior_patterns['submission_timestamps']
            time_pressure = 0.0
            
            if len(submission_timestamps) >= 2:
                recent_submissions = [t for t in submission_timestamps 
                                    if t >= datetime.now(UTC) - timedelta(minutes=5)]
                
                if len(recent_submissions) >= 2:
                    intervals = []
                    for i in range(1, len(recent_submissions)):
                        interval = (recent_submissions[i] - recent_submissions[i-1]).total_seconds()
                        intervals.append(interval)
                    
                    if intervals:
                        avg_interval = sum(intervals) / len(intervals)
                        # 间隔越短，时间压力越大
                        time_pressure = min(1.0, 60.0 / max(avg_interval, 10.0))
            
            # 加权综合计算挫败指数
            frustration_index = (
                emotional_frustration * 0.4 +      # 情感挫败权重40%
                error_frequency * 0.3 +            # 错误频率权重30%
                help_seeking * 0.2 +              # 求助倾向权重20%
                time_pressure * 0.1               # 时间压力权重10%
            )
            
            return min(1.0, max(0.0, frustration_index))
            
        except Exception as e:
            logger.error(f"计算挫败指数时发生错误: {e}")
            return 0.0