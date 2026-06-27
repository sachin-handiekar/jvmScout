"""add source_classes table (app-class bytecode for the decompiled source view)

Revision ID: 0004_source_classes
Revises: 0003_config_project_id
Create Date: 2026-06-27

Stores the original class-file bytes (base64) the agent ships for app classes,
so the collector can decompile them on demand. One row per (project, class).
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_source_classes"
down_revision = "0003_config_project_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "source_classes",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("project_id", sa.String(length=64), nullable=True),
        sa.Column("class_name", sa.String(length=256), nullable=False),
        sa.Column("received_at", sa.String(length=32), nullable=False),
        sa.Column("bytecode_b64", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_source_classes_project_id", "source_classes", ["project_id"])
    op.create_index("ix_source_classes_class_name", "source_classes", ["class_name"])


def downgrade() -> None:
    op.drop_index("ix_source_classes_class_name", table_name="source_classes")
    op.drop_index("ix_source_classes_project_id", table_name="source_classes")
    op.drop_table("source_classes")
