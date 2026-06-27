"""add project_id to exceptions and jvm_instances (multi-tenant scoping)

Revision ID: 0002_project_id
Revises: 0001_initial
Create Date: 2026-06-27

Adds the tenant column that the collector stamps from the ingest token and
filters every read by. Nullable so existing rows (ingested with the master key
/ before auth scoping) remain visible to the master/superadmin.
"""
from alembic import op
import sqlalchemy as sa

revision = "0002_project_id"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("exceptions", sa.Column("project_id", sa.String(length=64), nullable=True))
    op.create_index("ix_exceptions_project_id", "exceptions", ["project_id"])

    op.add_column("jvm_instances", sa.Column("project_id", sa.String(length=64), nullable=True))
    op.create_index("ix_jvm_instances_project_id", "jvm_instances", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_jvm_instances_project_id", table_name="jvm_instances")
    op.drop_column("jvm_instances", "project_id")
    op.drop_index("ix_exceptions_project_id", table_name="exceptions")
    op.drop_column("exceptions", "project_id")
