"""Pydantic v2 models for the agent wire format.

Field names are snake_case; the on-the-wire keys are camelCase, mapped via an
alias generator. `populate_by_name=True` lets us build models either way.
"""
from __future__ import annotations

from typing import Any, List, Optional

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.alias_generators import to_camel


class _Wire(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
    )


class Location(_Wire):
    class_name: Optional[str] = None
    method_name: Optional[str] = None
    line_number: Optional[int] = None
    source_file: Optional[str] = None


class ThreadInfo(_Wire):
    name: Optional[str] = None
    priority: Optional[int] = None
    is_daemon: Optional[bool] = None


class Cause(_Wire):
    exception_type: Optional[str] = None
    exception_message: Optional[str] = None


class LocalVariable(_Wire):
    name: Optional[str] = None
    signature: Optional[str] = None
    slot: Optional[int] = None
    type: Optional[str] = None
    value: Optional[str] = None
    source: Optional[str] = None


class StackFrame(_Wire):
    frame_index: Optional[int] = None
    class_name: Optional[str] = None
    method_name: Optional[str] = None
    line_number: Optional[int] = None
    source_file: Optional[str] = None
    is_app_code: Optional[bool] = None
    local_variables: List[LocalVariable] = []


class JvmMetrics(_Wire):
    heap_used_bytes: Optional[int] = None
    heap_max_bytes: Optional[int] = None
    gc_collection_count: Optional[int] = None
    gc_time_ms: Optional[int] = None
    thread_count: Optional[int] = None
    loaded_class_count: Optional[int] = None
    uptime_ms: Optional[int] = None


class ExceptionEvent(_Wire):
    timestamp: Optional[str] = None
    fingerprint: str = ""
    capture_mode: Optional[str] = None
    hit_count: int = 1
    deployment_id: Optional[str] = None
    instance_id: Optional[str] = None
    exception_type: Optional[str] = None
    exception_message: Optional[str] = None
    caught: Optional[bool] = None
    location: Optional[Location] = None
    caught_at: Optional[Location] = None
    thread_info: Optional[ThreadInfo] = None
    cause_chain: List[Cause] = []
    suppressed_exceptions: List[Cause] = []
    jvm_metrics: Optional[JvmMetrics] = None
    stack_trace: List[StackFrame] = []

    @field_validator("fingerprint", mode="before")
    @classmethod
    def _coerce_fingerprint(cls, v: Any) -> str:
        # fingerprint may arrive as int or string; store as string.
        return "" if v is None else str(v)


class JvmInfo(_Wire):
    version: Optional[str] = None
    vendor: Optional[str] = None
    vm_name: Optional[str] = None
    vm_version: Optional[str] = None
    runtime_name: Optional[str] = None


class HostInfo(_Wire):
    name: Optional[str] = None
    os: Optional[str] = None
    os_version: Optional[str] = None
    arch: Optional[str] = None
    kubernetes: Optional[bool] = None


class AgentStartEvent(_Wire):
    type: str = "agent_start"
    timestamp: Optional[str] = None
    instance_id: Optional[str] = None
    deployment_id: Optional[str] = None
    jvm_info: Optional[JvmInfo] = None
    host_info: Optional[HostInfo] = None
    jvm_args: List[str] = []
    classpath: Optional[str] = None
    env_vars: dict = {}
    system_properties: dict = {}
    agent_config: dict = {}
