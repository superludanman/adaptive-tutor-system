from app.celery_app import celery_app, get_dynamic_controller
from app.db.database import SessionLocal
from app.schemas.chat import ChatRequest

@celery_app.task
def process_chat_request(request_data: dict):
    db = SessionLocal()
    try:
        controller = get_dynamic_controller()
        # 将 db 会话传递给需要它的服务方法
        profile = controller.user_state_service.get_or_create_profile(
            participant_id=request_data['participant_id'],
            db=db
        )
        # 调用生成回复（使用同步函数）
        request_obj = ChatRequest(**request_data)
        response = controller.generate_adaptive_response_sync(
            request=request_obj,
            db=db,
            background_tasks=None  # Celery任务中不使用FastAPI的BackgroundTasks
        )
        # 注意：响应结果会自动存储在Celery的result backend中
        return response.model_dump()
    finally:
        db.close()