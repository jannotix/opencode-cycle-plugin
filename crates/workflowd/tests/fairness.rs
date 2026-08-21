use workflow_core::{ProjectId, TaskId, WorkflowId};
use workflowd::scheduler::queue::{FairQueue, ScheduledTask, SchedulingState};

fn task(project_id: ProjectId, workflow_id: WorkflowId, priority: i16) -> ScheduledTask {
    ScheduledTask {
        priority,
        project_id,
        task_id: TaskId::new(),
        workflow_id,
    }
}

#[test]
fn high_volume_project_cannot_starve_another_project() {
    let busy = ProjectId::new();
    let quiet = ProjectId::new();
    let mut queue = FairQueue::new();
    for _ in 0..100 {
        queue.enqueue(task(busy, WorkflowId::new(), 0), SchedulingState::Ready);
    }
    queue.enqueue(task(quiet, WorkflowId::new(), 0), SchedulingState::Ready);

    assert_eq!(queue.pop().unwrap().project_id, busy);
    assert_eq!(queue.pop().unwrap().project_id, quiet);
}

#[test]
fn priority_orders_work_within_project_without_bypassing_fairness() {
    let first_project = ProjectId::new();
    let second_project = ProjectId::new();
    let mut queue = FairQueue::new();
    queue.enqueue(
        task(first_project, WorkflowId::new(), 0),
        SchedulingState::Ready,
    );
    queue.enqueue(
        task(first_project, WorkflowId::new(), 10),
        SchedulingState::Ready,
    );
    queue.enqueue(
        task(second_project, WorkflowId::new(), -10),
        SchedulingState::Ready,
    );

    assert_eq!(queue.pop().unwrap().priority, 10);
    assert_eq!(queue.pop().unwrap().project_id, second_project);
    assert_eq!(queue.pop().unwrap().priority, 0);
}

#[test]
fn paused_and_blocked_workflows_consume_no_slot_and_resume_deterministically() {
    let project = ProjectId::new();
    let paused = WorkflowId::new();
    let blocked = WorkflowId::new();
    let ready = WorkflowId::new();
    let mut queue = FairQueue::new();
    queue.enqueue(task(project, paused, 100), SchedulingState::Paused);
    queue.enqueue(task(project, blocked, 90), SchedulingState::Blocked);
    queue.enqueue(task(project, ready, 0), SchedulingState::Ready);

    assert_eq!(queue.pop().unwrap().workflow_id, ready);
    assert!(queue.pop().is_none());
    queue.set_workflow_state(paused, SchedulingState::Ready);
    assert_eq!(queue.pop().unwrap().workflow_id, paused);
}
