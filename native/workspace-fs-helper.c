#define _DARWIN_C_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

enum {
    EXIT_OK = 0,
    EXIT_CONFLICT = 10,
    EXIT_NOT_FOUND = 12,
    EXIT_POLICY = 13,
    EXIT_FILE_TOO_LARGE = 14,
    EXIT_RESULT_TOO_LARGE = 15,
    EXIT_IO = 20,
};

enum {
    WORKSPACE_ROOT_FD = 3,
    PARENT_CONTROL_FD = 4,
    FIRST_OWNED_FD = 10,
    MAX_FIELDS = 6,
    MAX_PARENT_PATH_BYTES = 4096,
    MAX_READ_CONTENT_BYTES = 1024 * 1024,
    MAX_LIST_ENTRIES = 4096,
    MAX_LIST_PAYLOAD_BYTES = 4 + MAX_LIST_ENTRIES * (4 + NAME_MAX),
    METADATA_BYTES = 17,
};

typedef struct {
    unsigned char *data;
    size_t length;
} field_t;

typedef struct {
    uintmax_t device;
    uintmax_t inode;
} identity_t;

typedef struct {
    unsigned char *data;
    size_t length;
} response_t;

static const char PROTOCOL_VERSION_ARGUMENT[] = "--protocol-version";
static const char PROTOCOL_VERSION_LINE[] = "workspace-readonly-fd-v1\n";

static int parent_control_fd = -1;
static pid_t helper_process_group = -1;

static void *watch_parent_liveness(void *unused) {
    unsigned char unexpected;

    (void)unused;
    for (;;) {
        ssize_t count = read(parent_control_fd, &unexpected, 1U);
        if (count < 0 && errno == EINTR) {
            continue;
        }
        break;
    }

    if (killpg(helper_process_group, SIGKILL) != 0) {
        _exit(EXIT_IO);
    }
    for (;;) {
        (void)pause();
    }
}

static int start_parent_liveness_watcher(void) {
    pthread_t watcher;
    pid_t process_id = getpid();
    int descriptor;

    if (getpgrp() != process_id) {
        return EXIT_IO;
    }
    descriptor = fcntl(PARENT_CONTROL_FD, F_DUPFD_CLOEXEC, FIRST_OWNED_FD);
    if (descriptor < 0) {
        return EXIT_IO;
    }
    if (close(PARENT_CONTROL_FD) != 0) {
        (void)close(descriptor);
        return EXIT_IO;
    }

    parent_control_fd = descriptor;
    helper_process_group = process_id;
    if (pthread_create(&watcher, NULL, watch_parent_liveness, NULL) != 0) {
        parent_control_fd = -1;
        helper_process_group = -1;
        (void)close(descriptor);
        return EXIT_IO;
    }
    if (pthread_detach(watcher) != 0) {
        _exit(EXIT_IO);
    }
    return EXIT_OK;
}

static int write_all(int fd, const void *buffer, size_t length) {
    const unsigned char *cursor = buffer;

    while (length > 0) {
        ssize_t written = write(fd, cursor, length);
        if (written < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (written == 0) {
            return -1;
        }
        cursor += (size_t)written;
        length -= (size_t)written;
    }
    return 0;
}

static int read_all(int fd, void *buffer, size_t length) {
    unsigned char *cursor = buffer;

    while (length > 0) {
        ssize_t count = read(fd, cursor, length);
        if (count < 0) {
            if (errno == EINTR) {
                continue;
            }
            return -1;
        }
        if (count == 0) {
            return -1;
        }
        cursor += (size_t)count;
        length -= (size_t)count;
    }
    return 0;
}

static bool valid_utf8(const unsigned char *data, size_t length) {
    size_t index = 0;

    while (index < length) {
        unsigned char first = data[index];
        if (first <= 0x7fU) {
            index += 1;
            continue;
        }

        if (first >= 0xc2U && first <= 0xdfU) {
            if (index + 1 >= length || (data[index + 1] & 0xc0U) != 0x80U) {
                return false;
            }
            index += 2;
            continue;
        }

        if (first >= 0xe0U && first <= 0xefU) {
            if (index + 2 >= length || (data[index + 1] & 0xc0U) != 0x80U ||
                (data[index + 2] & 0xc0U) != 0x80U) {
                return false;
            }
            if ((first == 0xe0U && data[index + 1] < 0xa0U) ||
                (first == 0xedU && data[index + 1] >= 0xa0U)) {
                return false;
            }
            index += 3;
            continue;
        }

        if (first >= 0xf0U && first <= 0xf4U) {
            if (index + 3 >= length || (data[index + 1] & 0xc0U) != 0x80U ||
                (data[index + 2] & 0xc0U) != 0x80U ||
                (data[index + 3] & 0xc0U) != 0x80U) {
                return false;
            }
            if ((first == 0xf0U && data[index + 1] < 0x90U) ||
                (first == 0xf4U && data[index + 1] >= 0x90U)) {
                return false;
            }
            index += 4;
            continue;
        }

        return false;
    }

    return true;
}

static int read_field(field_t *field) {
    unsigned char header[4];
    uint32_t encoded_length;

    if (read_all(STDIN_FILENO, header, sizeof(header)) != 0) {
        return EXIT_IO;
    }

    encoded_length = ((uint32_t)header[0] << 24U) |
                     ((uint32_t)header[1] << 16U) |
                     ((uint32_t)header[2] << 8U) |
                     (uint32_t)header[3];
    if (encoded_length > MAX_PARENT_PATH_BYTES) {
        return EXIT_IO;
    }

    field->data = malloc((size_t)encoded_length + 1U);
    if (field->data == NULL) {
        return EXIT_IO;
    }
    field->length = encoded_length;

    if (encoded_length > 0 &&
        read_all(STDIN_FILENO, field->data, encoded_length) != 0) {
        return EXIT_IO;
    }
    field->data[encoded_length] = '\0';

    if (!valid_utf8(field->data, field->length) ||
        memchr(field->data, '\0', field->length) != NULL) {
        return EXIT_IO;
    }
    return EXIT_OK;
}

static int require_input_end(void) {
    unsigned char extra;

    for (;;) {
        ssize_t count = read(STDIN_FILENO, &extra, 1);
        if (count == 0) {
            return EXIT_OK;
        }
        if (count < 0 && errno == EINTR) {
            continue;
        }
        return EXIT_IO;
    }
}

static const char *field_text(const field_t *field) {
    return (const char *)field->data;
}

static int validate_basename(const field_t *field) {
    if (field->length == 0 || field->length > NAME_MAX ||
        memchr(field->data, '/', field->length) != NULL) {
        return EXIT_POLICY;
    }
    if ((field->length == 1 && field->data[0] == '.') ||
        (field->length == 2 && field->data[0] == '.' && field->data[1] == '.')) {
        return EXIT_POLICY;
    }
    return EXIT_OK;
}

static int parse_uint_field(const field_t *field, uintmax_t *value) {
    uintmax_t result = 0;
    size_t index;

    if (field->length == 0) {
        return EXIT_IO;
    }
    for (index = 0; index < field->length; index += 1) {
        unsigned char character = field->data[index];
        unsigned int digit;

        if (character < '0' || character > '9') {
            return EXIT_IO;
        }
        digit = (unsigned int)(character - '0');
        if (result > (UINTMAX_MAX - digit) / 10U) {
            return EXIT_IO;
        }
        result = result * 10U + digit;
    }
    *value = result;
    return EXIT_OK;
}

static int parse_identity(const field_t *device_field, const field_t *inode_field,
                          identity_t *identity) {
    int status = parse_uint_field(device_field, &identity->device);
    if (status != EXIT_OK) {
        return status;
    }
    return parse_uint_field(inode_field, &identity->inode);
}

static bool identity_matches(const struct stat *metadata, identity_t identity) {
    return (uintmax_t)metadata->st_dev == identity.device &&
           (uintmax_t)metadata->st_ino == identity.inode;
}

static bool identities_match(identity_t left, identity_t right) {
    return left.device == right.device && left.inode == right.inode;
}

static identity_t identity_from_stat(const struct stat *metadata) {
    identity_t identity = {
        .device = (uintmax_t)metadata->st_dev,
        .inode = (uintmax_t)metadata->st_ino,
    };
    return identity;
}

static bool stable_metadata(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
           left->st_size == right->st_size &&
           left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
           left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
           left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
           left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static void encode_uint32_be(unsigned char output[4], uint32_t value) {
    output[0] = (unsigned char)(value >> 24U);
    output[1] = (unsigned char)(value >> 16U);
    output[2] = (unsigned char)(value >> 8U);
    output[3] = (unsigned char)value;
}

static void encode_uint64_be(unsigned char output[8], uint64_t value) {
    size_t index;

    for (index = 0; index < 8; index += 1) {
        output[index] = (unsigned char)(value >> ((7U - index) * 8U));
    }
}

static unsigned char metadata_type(const struct stat *metadata) {
    mode_t mode = metadata->st_mode;
    if (S_ISREG(mode) && metadata->st_nlink == 1) {
        return 1;
    }
    if (S_ISDIR(mode)) {
        return 2;
    }
    if (S_ISLNK(mode)) {
        return 3;
    }
    return 4;
}

static void encode_metadata(unsigned char output[METADATA_BYTES],
                            const struct stat *metadata) {
    output[0] = metadata_type(metadata);
    encode_uint64_be(output + 1, (uint64_t)metadata->st_dev);
    encode_uint64_be(output + 9, (uint64_t)metadata->st_ino);
}

static int map_errno_status(int error_number) {
    switch (error_number) {
        case ENOENT:
            return EXIT_NOT_FOUND;
        case ENOTEMPTY:
        case EACCES:
        case EPERM:
        case EROFS:
        case ELOOP:
        case ENAMETOOLONG:
        case ENOTDIR:
        case EISDIR:
        case EINVAL:
        case EXDEV:
            return EXIT_POLICY;
        default:
            return EXIT_IO;
    }
}

static int acquire_root_fd(const field_t *device_field,
                           const field_t *inode_field, int *owned_fd,
                           identity_t *identity) {
    struct stat metadata;
    int descriptor;
    int status = parse_identity(device_field, inode_field, identity);

    if (status != EXIT_OK) {
        return status;
    }
    descriptor = fcntl(WORKSPACE_ROOT_FD, F_DUPFD_CLOEXEC, FIRST_OWNED_FD);
    if (descriptor < 0) {
        return EXIT_IO;
    }
    if (fstat(descriptor, &metadata) != 0) {
        (void)close(descriptor);
        return EXIT_IO;
    }
    if (!S_ISDIR(metadata.st_mode)) {
        (void)close(descriptor);
        return EXIT_POLICY;
    }
    if (!identity_matches(&metadata, *identity)) {
        (void)close(descriptor);
        return EXIT_CONFLICT;
    }
    *owned_fd = descriptor;
    return EXIT_OK;
}

static int duplicate_directory_fd(int descriptor, int *duplicate) {
    int result = fcntl(descriptor, F_DUPFD_CLOEXEC, FIRST_OWNED_FD);

    if (result < 0) {
        return EXIT_IO;
    }
    *duplicate = result;
    return EXIT_OK;
}

static bool is_dot_segment(const unsigned char *segment, size_t length) {
    return length == 1 && segment[0] == '.';
}

static bool is_dot_dot_segment(const unsigned char *segment, size_t length) {
    return length == 2 && segment[0] == '.' && segment[1] == '.';
}

static int walk_parent_fd(int root_fd, identity_t root_identity,
                          const field_t *relative_path, int *parent_fd,
                          identity_t *parent_identity) {
    struct stat metadata;
    char segment[NAME_MAX + 1];
    size_t start = 0;
    int current_fd = -1;
    int status;

    if (relative_path->length == 0 ||
        relative_path->length > MAX_PARENT_PATH_BYTES) {
        return EXIT_POLICY;
    }
    status = duplicate_directory_fd(root_fd, &current_fd);
    if (status != EXIT_OK) {
        return status;
    }

    if (relative_path->length == 1 && relative_path->data[0] == '.') {
        *parent_fd = current_fd;
        *parent_identity = root_identity;
        return EXIT_OK;
    }
    if (relative_path->data[0] == '/' ||
        relative_path->data[relative_path->length - 1U] == '/') {
        status = EXIT_POLICY;
        goto fail;
    }

    while (start < relative_path->length) {
        size_t end = start;
        size_t segment_length;
        int next_fd;

        while (end < relative_path->length && relative_path->data[end] != '/') {
            end += 1;
        }
        segment_length = end - start;
        if (segment_length == 0 || segment_length > NAME_MAX ||
            is_dot_segment(relative_path->data + start, segment_length) ||
            is_dot_dot_segment(relative_path->data + start, segment_length)) {
            status = EXIT_POLICY;
            goto fail;
        }

        memcpy(segment, relative_path->data + start, segment_length);
        segment[segment_length] = '\0';
        next_fd = openat(current_fd, segment,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (next_fd < 0) {
            status = map_errno_status(errno);
            goto fail;
        }
        if (fstat(next_fd, &metadata) != 0) {
            (void)close(next_fd);
            status = EXIT_IO;
            goto fail;
        }
        if (!S_ISDIR(metadata.st_mode) ||
            (uintmax_t)metadata.st_dev != root_identity.device) {
            (void)close(next_fd);
            status = EXIT_POLICY;
            goto fail;
        }
        (void)close(current_fd);
        current_fd = next_fd;
        start = end + 1U;
    }

    if (fstat(current_fd, &metadata) != 0) {
        status = EXIT_IO;
        goto fail;
    }
    *parent_identity = identity_from_stat(&metadata);
    *parent_fd = current_fd;
    return EXIT_OK;

fail:
    (void)close(current_fd);
    return status;
}

/*
 * Request fields are length-prefixed UTF-8. Every operation starts with the
 * identity of the inherited root descriptor. Reply bodies are binary and
 * emitted only after the request and the complete result pass validation.
 */
static int inspect_relative(int root_fd, identity_t root_identity,
                            const field_t *relative_path,
                            struct stat *metadata) {
    size_t split;
    field_t parent_path;
    field_t basename;
    identity_t parent_identity;
    int parent_fd = -1;
    int status;

    if (relative_path->length == 1 && relative_path->data[0] == '.') {
        if (fstat(root_fd, metadata) != 0) {
            return EXIT_IO;
        }
        return identity_matches(metadata, root_identity) ? EXIT_OK
                                                         : EXIT_CONFLICT;
    }
    if (relative_path->length == 0 ||
        relative_path->length > MAX_PARENT_PATH_BYTES ||
        relative_path->data[0] == '/' ||
        relative_path->data[relative_path->length - 1U] == '/') {
        return EXIT_POLICY;
    }

    split = relative_path->length;
    while (split > 0 && relative_path->data[split - 1U] != '/') {
        split -= 1;
    }
    basename.data = relative_path->data + split;
    basename.length = relative_path->length - split;
    status = validate_basename(&basename);
    if (status != EXIT_OK) {
        return status;
    }
    if (split == 0) {
        static unsigned char dot[] = ".";
        parent_path.data = dot;
        parent_path.length = 1;
    } else {
        parent_path.data = relative_path->data;
        parent_path.length = split - 1U;
    }
    status = walk_parent_fd(root_fd, root_identity, &parent_path, &parent_fd,
                            &parent_identity);
    if (status != EXIT_OK) {
        return status;
    }
    (void)parent_identity;
    if (fstatat(parent_fd, field_text(&basename), metadata,
                AT_SYMLINK_NOFOLLOW) != 0) {
        status = map_errno_status(errno);
    } else if ((uintmax_t)metadata->st_dev != root_identity.device) {
        status = EXIT_POLICY;
    }
    (void)close(parent_fd);
    return status;
}

static int run_inspect(field_t fields[MAX_FIELDS], response_t *response) {
    identity_t root_identity;
    struct stat metadata;
    int root_fd = -1;
    int status = acquire_root_fd(&fields[0], &fields[1], &root_fd,
                                 &root_identity);

    if (status != EXIT_OK) {
        return status;
    }
    status = inspect_relative(root_fd, root_identity, &fields[2], &metadata);
    if (status == EXIT_OK) {
        response->data = malloc(METADATA_BYTES);
        if (response->data == NULL) {
            status = EXIT_IO;
        } else {
            response->length = METADATA_BYTES;
            encode_metadata(response->data, &metadata);
        }
    }
    (void)close(root_fd);
    return status;
}


/* Re-resolve the directory from the root before emitting a complete result. */
static int recheck_directory(int root_fd, identity_t root_identity,
                             const field_t *relative_path, identity_t expected,
                             int *descriptor) {
    identity_t current;
    int reopened = -1;
    int status = walk_parent_fd(root_fd, root_identity, relative_path, &reopened, &current);
    if (status != EXIT_OK) {
        return status;
    }
    if (!identities_match(current, expected)) {
        (void)close(reopened);
        return EXIT_CONFLICT;
    }
    (void)close(*descriptor);
    *descriptor = reopened;
    return EXIT_OK;
}

static int run_read(field_t fields[MAX_FIELDS], response_t *response) {
    const field_t *parent_path = &fields[2];
    const field_t *target_name = &fields[3];
    identity_t root_identity;
    identity_t parent_identity;
    identity_t expected_identity;
    struct stat before;
    struct stat after;
    struct stat named;
    size_t content_length;
    size_t offset = 0;
    int root_fd = -1;
    int parent_fd = -1;
    int descriptor = -1;
    int status;

    status = validate_basename(target_name);
    if (status != EXIT_OK) {
        return status;
    }
    status = parse_identity(&fields[4], &fields[5], &expected_identity);
    if (status != EXIT_OK) {
        return status;
    }
    status = acquire_root_fd(&fields[0], &fields[1], &root_fd,
                             &root_identity);
    if (status != EXIT_OK) {
        return status;
    }
    status = walk_parent_fd(root_fd, root_identity, parent_path, &parent_fd,
                            &parent_identity);
    if (status != EXIT_OK) {
        goto cleanup;
    }
    if (fstatat(parent_fd, field_text(target_name), &named, AT_SYMLINK_NOFOLLOW) != 0) {
        status = map_errno_status(errno);
        goto cleanup;
    }
    if (!S_ISREG(named.st_mode) || named.st_nlink != 1 ||
        (uintmax_t)named.st_dev != root_identity.device) {
        status = EXIT_POLICY;
        goto cleanup;
    }
    if (!identity_matches(&named, expected_identity)) {
        status = EXIT_CONFLICT;
        goto cleanup;
    }
    descriptor = openat(parent_fd, field_text(target_name),
                        O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (descriptor < 0) {
        status = map_errno_status(errno);
        goto cleanup;
    }
    if (fstat(descriptor, &before) != 0) {
        status = EXIT_IO;
        goto cleanup;
    }
    if (!identity_matches(&before, expected_identity)) {
        status = EXIT_CONFLICT;
        goto cleanup;
    }
    if (!S_ISREG(before.st_mode) || before.st_nlink != 1 ||
        (uintmax_t)before.st_dev != root_identity.device) {
        status = EXIT_POLICY;
        goto cleanup;
    }
    if (before.st_size < 0 || (uintmax_t)before.st_size > MAX_READ_CONTENT_BYTES) {
        status = EXIT_FILE_TOO_LARGE;
        goto cleanup;
    }
    content_length = (size_t)before.st_size;
    response->length = content_length;
    response->data = malloc(content_length == 0 ? 1U : content_length);
    if (response->data == NULL) {
        status = EXIT_IO;
        goto cleanup;
    }
    while (offset < content_length) {
        ssize_t count = read(descriptor,
                             response->data + offset,
                             content_length - offset);
        if (count < 0 && errno == EINTR) {
            continue;
        }
        if (count <= 0) {
            status = count == 0 ? EXIT_CONFLICT : EXIT_IO;
            goto cleanup;
        }
        offset += (size_t)count;
    }
    {
        unsigned char extra;
        ssize_t count;
        do {
            count = read(descriptor, &extra, 1);
        } while (count < 0 && errno == EINTR);
        if (count != 0) {
            status = count > 0 ? EXIT_CONFLICT : EXIT_IO;
            goto cleanup;
        }
    }
    if (fstat(descriptor, &after) != 0) {
        status = EXIT_IO;
        goto cleanup;
    }
    if (!S_ISREG(after.st_mode) || after.st_nlink != 1 ||
        !stable_metadata(&before, &after) || offset != content_length) {
        status = EXIT_CONFLICT;
        goto cleanup;
    }
    status = recheck_directory(root_fd, root_identity, parent_path,
                               parent_identity, &parent_fd);
    if (status != EXIT_OK) {
        goto cleanup;
    }
    if (fstatat(parent_fd, field_text(target_name), &named, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(named.st_mode) || named.st_nlink != 1 ||
        !stable_metadata(&after, &named)) {
        status = EXIT_CONFLICT;
    }

cleanup:
    if (status != EXIT_OK) {
        free(response->data);
        response->data = NULL;
        response->length = 0;
    }
    if (descriptor >= 0) {
        (void)close(descriptor);
    }
    if (parent_fd >= 0) {
        (void)close(parent_fd);
    }
    if (root_fd >= 0) {
        (void)close(root_fd);
    }
    return status;
}

static int run_list(field_t fields[MAX_FIELDS], response_t *response) {
    identity_t root_identity;
    identity_t expected_identity;
    identity_t directory_identity;
    struct stat before;
    struct stat after;
    int root_fd = -1;
    int directory_fd = -1;
    DIR *stream = NULL;
    size_t count = 0;
    size_t offset = 4;

    int status = parse_identity(&fields[3], &fields[4], &expected_identity);
    if (status != EXIT_OK) {
        return status;
    }
    status = acquire_root_fd(&fields[0], &fields[1], &root_fd, &root_identity);
    if (status != EXIT_OK) {
        return status;
    }
    status = walk_parent_fd(root_fd, root_identity, &fields[2], &directory_fd,
                            &directory_identity);
    if (status != EXIT_OK) {
        goto cleanup;
    }
    if (!identities_match(directory_identity, expected_identity)) {
        status = EXIT_CONFLICT;
        goto cleanup;
    }
    if (fstat(directory_fd, &before) != 0) {
        status = EXIT_IO;
        goto cleanup;
    }

    int stream_fd = openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (stream_fd < 0) {
        status = map_errno_status(errno);
        goto cleanup;
    }
    stream = fdopendir(stream_fd);
    if (stream == NULL) {
        (void)close(stream_fd);
        status = EXIT_IO;
        goto cleanup;
    }

    response->data = malloc(MAX_LIST_PAYLOAD_BYTES);
    if (response->data == NULL) {
        status = EXIT_IO;
        goto cleanup;
    }

    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(stream);
        if (entry == NULL) {
            if (errno != 0) {
                status = EXIT_IO;
                goto cleanup;
            }
            break;
        }
        size_t name_length = strlen(entry->d_name);
        const unsigned char *name = (const unsigned char *)entry->d_name;
        if (is_dot_segment(name, name_length) || is_dot_dot_segment(name, name_length)) {
            continue;
        }
        if (count >= MAX_LIST_ENTRIES) {
            status = EXIT_RESULT_TOO_LARGE;
            goto cleanup;
        }
        if (name_length == 0 || name_length > NAME_MAX || !valid_utf8(name, name_length)) {
            status = EXIT_POLICY;
            goto cleanup;
        }
        encode_uint32_be(response->data + offset, (uint32_t)name_length);
        offset += 4;
        memcpy(response->data + offset, name, name_length);
        offset += name_length;
        count += 1;
    }

    status = recheck_directory(root_fd, root_identity, &fields[2], directory_identity, &directory_fd);
    if (status != EXIT_OK) {
        goto cleanup;
    }
    if (fstat(directory_fd, &after) != 0 || !stable_metadata(&before, &after)) {
        status = EXIT_CONFLICT;
        goto cleanup;
    }
    encode_uint32_be(response->data, (uint32_t)count);
    response->length = offset;

cleanup:
    if (stream != NULL) {
        (void)closedir(stream);
    }
    if (directory_fd >= 0) {
        (void)close(directory_fd);
    }
    (void)close(root_fd);
    return status;
}

int main(int argc, char **argv) {
    field_t fields[MAX_FIELDS] = {{0}};
    response_t response = {0};
    size_t field_count;
    int status = EXIT_IO;

    if (argc != 2 || start_parent_liveness_watcher() != EXIT_OK) {
        return EXIT_IO;
    }
    if (strcmp(argv[1], PROTOCOL_VERSION_ARGUMENT) == 0) {
        if (require_input_end() != EXIT_OK) {
            return EXIT_IO;
        }
        return write_all(STDOUT_FILENO, PROTOCOL_VERSION_LINE,
                         sizeof(PROTOCOL_VERSION_LINE) - 1U) == 0 ? EXIT_OK : EXIT_IO;
    }

    int (*operation)(field_t fields[MAX_FIELDS], response_t *response);
    if (strcmp(argv[1], "inspect") == 0) {
        field_count = 3;
        operation = run_inspect;
    } else if (strcmp(argv[1], "list") == 0) {
        field_count = 5;
        operation = run_list;
    } else if (strcmp(argv[1], "read") == 0) {
        field_count = 6;
        operation = run_read;
    } else {
        return EXIT_POLICY;
    }

    for (size_t index = 0; index < field_count; index += 1) {
        status = read_field(&fields[index]);
        if (status != EXIT_OK) {
            goto finish;
        }
    }
    status = require_input_end();
    if (status == EXIT_OK) {
        status = operation(fields, &response);
    }

finish:
    for (size_t index = 0; index < field_count; index += 1) {
        free(fields[index].data);
    }
    if (status == EXIT_OK &&
        write_all(STDOUT_FILENO, response.data, response.length) != 0) {
        status = EXIT_IO;
    }
    free(response.data);
    return status;
}
