import pytest

from parking_analytics.synthetic import create_smoke


@pytest.fixture(scope="session")
def smoke(tmp_path_factory):
    directory = tmp_path_factory.mktemp("synthetic") / "replay"
    return create_smoke(directory), directory
