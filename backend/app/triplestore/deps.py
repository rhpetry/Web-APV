from typing import Annotated

from fastapi import Depends, File, Form, UploadFile
from pydantic import BaseModel


class SubmissionInput(BaseModel):
    ontology_file: UploadFile | None
    triplestore_url: str | None
    jwt_auth_enabled: bool
    auth_server_url: str | None
    username: str | None
    password: str | None
    jwt_token: str | None


async def get_submission_input(
    ontology_file: Annotated[UploadFile | None, File()] = None,
    triplestore_url: Annotated[str | None, Form()] = None,
    jwt_auth_enabled: Annotated[bool, Form()] = False,
    auth_server_url: Annotated[str | None, Form()] = None,
    username: Annotated[str | None, Form()] = None,
    password: Annotated[str | None, Form()] = None,
    jwt_token: Annotated[str | None, Form()] = None,
) -> SubmissionInput:
    return SubmissionInput(
        ontology_file=ontology_file,
        triplestore_url=triplestore_url,
        jwt_auth_enabled=jwt_auth_enabled,
        auth_server_url=auth_server_url,
        username=username,
        password=password,
        jwt_token=jwt_token,
    )


SubmissionInputDep = Annotated[SubmissionInput, Depends(get_submission_input)]
