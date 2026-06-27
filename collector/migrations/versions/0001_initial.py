"""initial schema: exceptions, jvm_instances, config_entities

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-23
"""
from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "exceptions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("received_at", sa.String(length=32), nullable=False),
        sa.Column("timestamp", sa.String(length=32), nullable=True),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("capture_mode", sa.String(length=16), nullable=True),
        sa.Column("hit_count", sa.Integer(), nullable=False),
        sa.Column("deployment_id", sa.String(length=128), nullable=True),
        sa.Column("environment", sa.String(length=32), nullable=True),
        sa.Column("instance_id", sa.String(length=64), nullable=True),
        sa.Column("exception_type", sa.String(length=256), nullable=True),
        sa.Column("exception_message", sa.Text(), nullable=True),
        sa.Column("caught", sa.Boolean(), nullable=True),
        sa.Column("class_name", sa.String(length=256), nullable=True),
        sa.Column("method_name", sa.String(length=256), nullable=True),
        sa.Column("line_number", sa.Integer(), nullable=True),
        sa.Column("source_file", sa.String(length=256), nullable=True),
        sa.Column("thread_name", sa.String(length=128), nullable=True),
        sa.Column("raw_json", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_exceptions_fingerprint", "exceptions", ["fingerprint"])
    op.create_index("ix_exceptions_deployment_id", "exceptions", ["deployment_id"])
    op.create_index("ix_exceptions_environment", "exceptions", ["environment"])
    op.create_index("ix_exceptions_instance_id", "exceptions", ["instance_id"])
    op.create_index("ix_exceptions_exception_type", "exceptions", ["exception_type"])

    op.create_table(
        "jvm_instances",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("received_at", sa.String(length=32), nullable=False),
        sa.Column("timestamp", sa.String(length=32), nullable=True),
        sa.Column("instance_id", sa.String(length=64), nullable=False),
        sa.Column("deployment_id", sa.String(length=128), nullable=True),
        sa.Column("host_name", sa.String(length=256), nullable=True),
        sa.Column("jvm_version", sa.String(length=64), nullable=True),
        sa.Column("jvm_vendor", sa.String(length=128), nullable=True),
        sa.Column("os_name", sa.String(length=128), nullable=True),
        sa.Column("kubernetes", sa.Boolean(), nullable=True),
        sa.Column("raw_json", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jvm_instances_instance_id", "jvm_instances", ["instance_id"], unique=True)
    op.create_index("ix_jvm_instances_deployment_id", "jvm_instances", ["deployment_id"])

    op.create_table(
        "config_entities",
        sa.Column("pk", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("table", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.String(length=32), nullable=False),
        sa.Column("json_data", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("pk"),
    )
    op.create_index("ix_config_entities_table", "config_entities", ["table"])
    op.create_index("ix_config_entities_entity_id", "config_entities", ["entity_id"])


def downgrade() -> None:
    op.drop_table("config_entities")
    op.drop_table("jvm_instances")
    op.drop_table("exceptions")
