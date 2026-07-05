"""add exceptions.occurrences + hot-path indexes

Revision ID: 0004_occurrences_hot_indexes
Revises: 0003_config_project_id
Create Date: 2026-07-05

`occurrences` is how many real throws a row represents: 1 for normal events,
>1 for the agent's aggregated COUNT_ONLY summaries. Volume alerts and the
chart endpoints SUM it (hit_count is a cumulative display counter and must
never be summed). The indexes back every time-windowed query: charts, volume
alerts, and retention purge all filter on received_at.
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_occurrences_hot_indexes"
down_revision = "0003_config_project_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("exceptions",
                  sa.Column("occurrences", sa.Integer(), nullable=True))
    op.create_index("ix_exceptions_received_at", "exceptions", ["received_at"])
    op.create_index("ix_exceptions_project_received", "exceptions",
                    ["project_id", "received_at"])
    op.create_index("ix_exceptions_fingerprint_received", "exceptions",
                    ["fingerprint", "received_at"])


def downgrade() -> None:
    op.drop_index("ix_exceptions_fingerprint_received", table_name="exceptions")
    op.drop_index("ix_exceptions_project_received", table_name="exceptions")
    op.drop_index("ix_exceptions_received_at", table_name="exceptions")
    op.drop_column("exceptions", "occurrences")
