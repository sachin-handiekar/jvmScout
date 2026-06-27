"""add project_id to config_entities (per-project alert/redaction/token rules)

Revision ID: 0003_config_project_id
Revises: 0002_project_id
Create Date: 2026-06-27

Scopes UI-managed config rows (alert rules, redaction rules, tokens, etc.) to a
tenant. Nullable so existing rows belong to the default project / master view.
"""
from alembic import op
import sqlalchemy as sa

revision = "0003_config_project_id"
down_revision = "0002_project_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("config_entities",
                  sa.Column("project_id", sa.String(length=64), nullable=True))
    op.create_index("ix_config_entities_project_id", "config_entities", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_config_entities_project_id", table_name="config_entities")
    op.drop_column("config_entities", "project_id")
