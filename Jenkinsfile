pipeline {
    agent { label 'w-suqi-builder' }

    options {
        disableConcurrentBuilds()
        skipDefaultCheckout()
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {
        stage('Verify configuration and checkout') {
            steps {
                sh '''
                    set -eu
                    printf '%s\n' "${SUQI_ACR_REPOSITORY:?configure SUQI_ACR_REPOSITORY}" |
                        grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9_/-]+/w-suqi$'
                    printf '%s\n' "${SUQI_TARGET_SSH_HOST:?configure the approved SSH alias}" |
                        grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'
                    : "${SUQI_ACR_PUSH_CREDENTIALS_ID:?configure ACR push credentials}"
                    : "${SUQI_SSH_CREDENTIALS_ID:?configure the target SSH credential}"
                    docker version --format '{{.Server.Version}}'
                '''
                checkout scm
                script {
                    env.SUQI_REVISION = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.SUQI_TAG = "${env.SUQI_ACR_REPOSITORY}:${env.SUQI_REVISION}"
                }
            }
        }

        stage('Build and smoke test') {
            steps {
                sh '''
                    set -eu
                    docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$SUQI_REVISION" -t "$SUQI_TAG" .
                    sh deploy/smoke.sh "$SUQI_TAG"
                '''
            }
        }

        stage('Push preview image') {
            steps {
                withCredentials([usernamePassword(credentialsId: env.SUQI_ACR_PUSH_CREDENTIALS_ID,
                    usernameVariable: 'ACR_USERNAME', passwordVariable: 'ACR_PASSWORD')]) {
                    sh '''
                        set +x
                        set -eu
                        export DOCKER_CONFIG="$(mktemp -d)"
                        trap 'rm -r -- "$DOCKER_CONFIG"' EXIT
                        printf '%s' "$ACR_PASSWORD" | docker login "${SUQI_ACR_REPOSITORY%%/*}" --username "$ACR_USERNAME" --password-stdin
                        docker push "$SUQI_TAG"
                        docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$SUQI_TAG" |
                            awk -v prefix="$SUQI_ACR_REPOSITORY@" 'index($0, prefix) == 1' > image-ref.txt
                        test "$(wc -l < image-ref.txt)" -eq 1
                    '''
                }
                archiveArtifacts artifacts: 'image-ref.txt', fingerprint: true
            }
        }

        stage('Pull and verify on test host') {
            steps {
                sshagent(credentials: [env.SUQI_SSH_CREDENTIALS_ID]) {
                    sh '''
                        set -eu
                        image_ref="$(cat image-ref.txt)"
                        { cat deploy/smoke.sh; cat deploy/preview-target.sh; } |
                            ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 \
                                "$SUQI_TARGET_SSH_HOST" sh -s -- "$image_ref" "$SUQI_REVISION"
                    '''
                }
            }
        }
    }
}
